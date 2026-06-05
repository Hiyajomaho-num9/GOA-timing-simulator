import { defaultTpGeneratorConfig, ek86707aSet1OutputCount } from './types';
import type { CombinType, DraftProject, Edge, DualEk86707aConfig, Ek86707aConfig, Ek86707aCommonConfig, Ek86752bConfig, GpoConfig, Iml7272bConfig, LogicLevel, Measurement, MeasurementResult, Segment, SignalFamily, SignalTrace, SimulationResult, TerCpv2Inference, TimingBase, TpGeneratorConfig } from './types';
import { absPcnt, formatCount4 } from './time';

const COLORS = [
  '#7fa6bd',
  '#b9a36d',
  '#b07a82',
  '#8ea77d',
  '#b18463',
  '#9583b8',
  '#6fa99d',
  '#aa829e',
  '#7894bd',
  '#c2cad3',
  '#ad826b',
  '#85aaa9',
  '#b8949b',
  '#a8b77d',
  '#a997bf',
  '#d2d6dc',
];
const CK_COLORS = ['#7fa6bd', '#b9a36d', '#ad826b', '#9583b8', '#8ea77d', '#b5879f', '#6fa99d', '#b18463', '#7894bd', '#c2cad3', '#b07a82', '#a8b77d', '#85aaa9', '#a997bf', '#d2d6dc', '#9b8f79'];

export function simulateProject(project: DraftProject): SimulationResult {
  if (!project.timing) throw new Error('Timing base is missing. Import XLSX first.');
  const timing = project.timing;
  const linePcnt = timing.pcntPerLine;
  const warnings = validateGpos(project.gpos, timing);
  const rawSignals = new Map<number, SignalTrace>();
  const mergeSignals = new Map<number, SignalTrace>();

  for (const gpo of project.gpos) {
    const segments = simulateGpoBase(gpo, timing, false);
    rawSignals.set(gpo.index, makeSignal(`gpo${gpo.index}:raw`, `${gpo.group} raw`, 'raw', segments, gpo.index));
  }

  for (const gpo of project.gpos) {
    const own = rawSignals.get(gpo.index)?.segments ?? [];
    const other = rawSignals.get(gpo.combinSel)?.segments ?? [];
    const merged = applyCombin(gpo.combinType, own, other, linePcnt * timing.vtotal);
    mergeSignals.set(gpo.index, makeSignal(`gpo${gpo.index}:merge`, `${gpo.group} merge`, 'merge', merged, gpo.index));
  }

  const families = detectFamilies(project.gpos);
  const signals = buildDisplaySignals(families, rawSignals, mergeSignals, project.rstGpo);
  if (timing.soc === 'mt9603') {
    upsertMt9603DriverTp(signals, project.tpGenerator, timing, warnings);
  }
  const gpoSignals = buildGpoSignals(project.gpos, rawSignals, mergeSignals);
  if (isEk86707a(project.levelShifter)) {
    appendEkMappedSignals(project.levelShifter, signals, gpoSignals);
  }
  const inference = isEk86707a(project.levelShifter)
    ? inferTerCpv2(ekMappedGpoIndex(project.levelShifter.inputs.cpv2, gpoSignals) ?? families.find((f) => f.id === 'cpv2')?.rawGpo, project.gpos, project.levelShifter.ocpSel)
    : { role: 'UNKNOWN', severity: 'ok', message: project.levelShifter.model === 'single-iml7272b' || project.levelShifter.model === 'single-ek86752b' ? 'Level Shifter 输入由用户在参数页映射，不使用 EK86707A TER/CPV2 自动判定。' : '未启用 Level Shifter：仅显示 SoC GPO raw/out。' } satisfies TerCpv2Inference;
  const lsSignals = project.levelShifter.model === 'single-ek86707a'
    ? simulateEk86707aPreview(project.levelShifter, signals, gpoSignals, inference, timing)
    : project.levelShifter.model === 'dual-ek86707a'
      ? simulateDualEk86707aPreview(project.levelShifter, signals, gpoSignals, timing)
      : project.levelShifter.model === 'single-iml7272b'
        ? simulateIml7272bPreview(project.levelShifter, signals, gpoSignals, timing, warnings)
        : project.levelShifter.model === 'single-ek86752b'
          ? simulateEk86752bPreview(project.levelShifter, signals, gpoSignals, timing, warnings)
          : [];
  signals.push(...lsSignals);

  const allEdges = [...(project.manualEdges ?? []), ...signals.flatMap((s) => s.edges), ...gpoSignals.flatMap((s) => s.edges)];
  const measurements = project.measurements.map((m) => resolveMeasurement(m, allEdges, timing));

  return { timing, signals, gpoSignals, families, inference, measurements, warnings };
}

function isEk86707a(config: DraftProject['levelShifter']): config is Ek86707aConfig | DualEk86707aConfig {
  return config.model === 'single-ek86707a' || config.model === 'dual-ek86707a';
}

function appendEkMappedSignals(config: Ek86707aConfig | DualEk86707aConfig, signals: SignalTrace[], gpoSignals: SignalTrace[]): void {
  const all = [...signals, ...gpoSignals];
  const append = (inputId: string | undefined, signalId: string, name: string) => {
    if (!inputId || signals.some((signal) => signal.id === signalId)) return;
    const source = all.find((signal) => signal.id === inputId);
    if (!source) return;
    signals.push({
      ...source,
      id: signalId,
      name,
      kind: signalId === 'rst:manual' ? 'manual' : 'merge',
      edges: extractEdges(signalId, name, source.segments, source.sourceGpo),
    });
  };
  append(config.inputs.driverTp, 'driver_tp:merge', 'Driver_TP out');
  append(config.inputs.initTp, 'init_tp:merge', 'Init_TP out');
  append(config.inputs.stv, 'stv:merge', 'STV out');
  append(config.inputs.cpv1, 'cpv1:merge', 'CPV1 out');
  append(config.inputs.cpv2, 'cpv2:merge', 'CPV2 out');
  append(config.inputs.ter, 'ter:manual', 'TER out');
  append(config.inputs.rst, 'rst:manual', 'RST out');
  append(config.inputs.pol, 'pol:merge', 'POL out');
}

function ekMappedGpoIndex(id: string | undefined, gpoSignals: SignalTrace[]): number | undefined {
  if (!id) return undefined;
  return gpoSignals.find((signal) => signal.id === id)?.sourceGpo;
}

function upsertMt9603DriverTp(signals: SignalTrace[], config: TpGeneratorConfig | undefined, timing: TimingBase, warnings: string[]): void {
  const synthetic = buildMt9603DriverTp(config ?? defaultTpGeneratorConfig(), timing, warnings);
  for (const id of ['driver_tp:raw', 'driver_tp:source', 'driver_tp:merge']) {
    const index = signals.findIndex((signal) => signal.id === id);
    if (index >= 0) signals.splice(index, 1);
  }
  signals.unshift(
    { ...synthetic, id: 'driver_tp:raw', name: 'Driver_TP raw', kind: 'raw', edges: extractEdges('driver_tp:raw', 'Driver_TP raw', synthetic.segments) },
    { ...synthetic, id: 'driver_tp:merge', name: 'Driver_TP out', kind: 'merge', edges: extractEdges('driver_tp:merge', 'Driver_TP out', synthetic.segments) },
  );
}

function buildMt9603DriverTp(config: TpGeneratorConfig, timing: TimingBase, warnings: string[]): SignalTrace {
  const total = timing.pcntPerLine * timing.vtotal;
  const start = Math.min(2, Math.max(0, total - 1));
  const width = parseDurationToPcnt(config.driverTpWidth, timing, 3e-6);
  const period = parseMt9603DriverTpPeriod(config, timing);
  const effectivePeriod = Math.max(1, period);
  let effectiveWidth = Math.max(1, width);
  if (effectiveWidth >= effectivePeriod) {
    effectiveWidth = Math.max(1, effectivePeriod - 1);
    warnings.push(`MT9603 Driver_TP: width=${width}pcnt >= period=${period}pcnt，已裁到 ${effectiveWidth}pcnt。`);
  }
  const highs: Segment[] = [];
  for (let at = start; at < total; at += effectivePeriod) {
    highs.push({ start: at, end: Math.min(at + effectiveWidth, total), level: 1, source: 'mt9603-data-cmd-driver-tp' });
  }
  const segments = highPulsesToSegments(highs, total, 'mt9603-data-cmd-driver-tp-low');
  return makeSignal('driver_tp:merge', 'Driver_TP out', 'merge', segments, undefined);
}

function parseDurationToPcnt(value: string, timing: TimingBase, fallbackSeconds: number): number {
  const text = value.trim().toLowerCase();
  if (!text) return Math.max(1, Math.round(fallbackSeconds / timing.pcntSeconds));
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)\s*(ns|us|µs|μs|ms|s)?$/i);
  if (!match) return Math.max(1, Math.round(fallbackSeconds / timing.pcntSeconds));
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return Math.max(1, Math.round(fallbackSeconds / timing.pcntSeconds));
  const unit = match[2] ?? 'us';
  const scale = unit === 'ns' ? 1e-9 : unit === 'ms' ? 1e-3 : unit === 's' ? 1 : 1e-6;
  return Math.max(1, Math.round((amount * scale) / timing.pcntSeconds));
}

function parseMt9603DriverTpPeriod(config: TpGeneratorConfig, timing: TimingBase): number {
  const mode = config.driverTpPeriodMode ?? 'line';
  if (mode === 'line') return Math.max(1, timing.pcntPerLine);
  if (mode === 'pcnt') {
    const text = config.driverTpPeriod.trim().toLowerCase().replace(/\s*pcnt$/, '');
    const amount = Number(text);
    return Number.isFinite(amount) && amount > 0 ? Math.max(1, Math.round(amount)) : Math.max(1, timing.pcntPerLine);
  }
  return parseDurationToPcnt(config.driverTpPeriod, timing, timing.lcntSeconds);
}

function simulateGpoBase(gpo: GpoConfig, timing: TimingBase, bypassMask: boolean): Segment[] {
  return simulateGpoWindow(gpo, timing, bypassMask, 1);
}

export function simulateGpoWindow(gpo: GpoConfig, timing: TimingBase, bypassMask: boolean, frameWindow: number): Segment[] {
  const linePcnt = timing.pcntPerLine;
  const total = linePcnt * timing.vtotal * Math.max(1, frameWindow);
  const frameTotal = linePcnt * timing.vtotal;
  const enabled = gpo.entries.filter((entry) => entry.enabled).sort((a, b) => {
    const aa = gpo.repeatMode === 0 ? absPcnt(a.lcnt, a.pcnt, linePcnt) : absPcnt(a.lcnt, a.pcnt, linePcnt);
    const bb = gpo.repeatMode === 0 ? absPcnt(b.lcnt, b.pcnt, linePcnt) : absPcnt(b.lcnt, b.pcnt, linePcnt);
    return gpo.repeatMode === 0 ? aa - bb || a.index - b.index : a.frameCount - b.frameCount || aa - bb || a.index - b.index;
  });
  let segments = gpo.repeatMode === 0 ? byLineSegments(gpo, enabled, timing, frameWindow) : byFrameSegments(gpo, enabled, timing, frameWindow);
  if (gpo.perFrameInv) segments = segments.map((s) => ({ ...s, level: invert(s.level) }));
  if (!bypassMask) segments = applyMask(segments, gpo, timing, frameWindow);
  return normalizeSegments(segments, Math.max(total, frameTotal));
}

export function simulateGpoOutWindow(gpo: GpoConfig, gpos: GpoConfig[], timing: TimingBase, bypassMask: boolean, frameWindow: number): Segment[] {
  const total = timing.pcntPerLine * timing.vtotal * Math.max(1, frameWindow);
  const own = simulateGpoWindow(gpo, timing, bypassMask, frameWindow);
  const otherGpo = gpos.find((item) => item.index === gpo.combinSel);
  const other = otherGpo ? simulateGpoWindow(otherGpo, timing, bypassMask, frameWindow) : [];
  return applyCombin(gpo.combinType, own, other, total);
}

function byFrameSegments(gpo: GpoConfig, entries: GpoConfig['entries'], timing: TimingBase, frameWindow: number): Segment[] {
  const frameTotal = timing.pcntPerLine * timing.vtotal;
  const total = frameTotal * Math.max(1, frameWindow);
  const periodFrames = Math.max(1, gpo.repeatCount + 1);
  const periodTotal = periodFrames * frameTotal;
  const events = entries
    .map((entry) => ({ entry, at: entry.frameCount * frameTotal + absPcnt(entry.lcnt, entry.pcnt, timing.pcntPerLine) }))
    .filter((event) => event.at >= 0 && event.at < periodTotal)
    .sort((a, b) => a.at - b.at || a.entry.index - b.entry.index);
  let cursor = 0;
  let level: LogicLevel = events.length > 0 ? events[events.length - 1].entry.level : 0;
  const segments: Segment[] = [];
  for (let periodStart = 0; periodStart < total; periodStart += periodTotal) {
    for (const event of events) {
      const at = periodStart + event.at;
      if (at >= total) continue;
      if (at > cursor) segments.push({ start: cursor, end: at, level, source: gpo.group });
      level = event.entry.level;
      cursor = at;
    }
  }
  if (cursor < total) segments.push({ start: cursor, end: total, level, source: gpo.group });
  return segments;
}

function byLineSegments(gpo: GpoConfig, entries: GpoConfig['entries'], timing: TimingBase, frameWindow: number): Segment[] {
  const segments: Segment[] = [];
  let carry: LogicLevel = 0;
  const periodLines = Math.max(1, gpo.repeatCount + 1);
  const lineEntries = entries
    .filter((e) => e.pcnt >= 0 && e.pcnt < timing.pcntPerLine)
    .sort((a, b) => a.lcnt - b.lcnt || a.pcnt - b.pcnt || a.index - b.index);
  const totalLines = timing.vtotal * Math.max(1, frameWindow);
  for (let line = 0; line < totalLines; line += 1) {
    const repeatLine = line % periodLines;
    const lineSegments = buildLineSegments(gpo, line, repeatLine, lineEntries, timing, carry);
    segments.push(...lineSegments.segments);
    carry = lineSegments.carry;
  }
  return segments;
}

function buildLineSegments(
  gpo: GpoConfig,
  line: number,
  repeatLine: number,
  entries: GpoConfig['entries'],
  timing: TimingBase,
  carryIn: LogicLevel,
): { segments: Segment[]; carry: LogicLevel } {
  const linePcnt = timing.pcntPerLine;
  const lineStart = line * linePcnt;
  const lineEnd = lineStart + linePcnt;
  const segments: Segment[] = [];
  let cursor = lineStart;
  let level = carryIn;
  for (const entry of entries.filter((item) => item.lcnt === repeatLine)) {
    const at = lineStart + entry.pcnt;
    if (at > cursor) segments.push({ start: cursor, end: at, level, source: gpo.group });
    level = entry.level;
    cursor = at;
  }
  if (cursor < lineEnd) segments.push({ start: cursor, end: lineEnd, level, source: gpo.group });
  return { segments, carry: level };
}

function applyMask(segments: Segment[], gpo: GpoConfig, timing: TimingBase, frameWindow: number): Segment[] {
  if (!gpo.maskEnabled) return segments;
  const total = timing.pcntPerLine * timing.vtotal * Math.max(1, frameWindow);
  const frameTotal = timing.pcntPerLine * timing.vtotal;
  const gateWindows = maskGateWindows(gpo, timing, frameWindow);
  if (gateWindows.length === 0) return [{ start: 0, end: total, level: gpo.regionOtherValue, source: `${gpo.group}:mask-gate` }];
  const cuts = new Set<number>([0, total]);
  for (const segment of segments) {
    cuts.add(segment.start);
    cuts.add(segment.end);
  }
  for (const gate of gateWindows) {
    cuts.add(gate.start);
    cuts.add(gate.end);
  }
  const points = [...cuts].filter((point) => point >= 0 && point <= total).sort((a, b) => a - b);
  const out: Segment[] = [];
  let segmentIndex = 0;
  let gateIndex = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    while (segments[segmentIndex + 1] && segments[segmentIndex].end <= start) segmentIndex += 1;
    while (gateWindows[gateIndex + 1] && gateWindows[gateIndex].end <= start) gateIndex += 1;
    const segment = segments[segmentIndex];
    const gate = gateWindows[gateIndex];
    const insideSegment = segment && segment.start <= start && segment.end > start;
    const gateHigh = gate && gate.start <= start && gate.end > start;
    out.push({
      start,
      end,
      level: gateHigh && insideSegment ? segment.level : gpo.regionOtherValue,
      source: gateHigh ? segment?.source : `${gpo.group}:mask-gate`,
    });
  }
  return normalizeSegments(out, Math.max(total, frameTotal));
}

function maskGateWindows(gpo: GpoConfig, timing: TimingBase, frameWindow: number): Array<{ start: number; end: number }> {
  const total = timing.pcntPerLine * timing.vtotal * Math.max(1, frameWindow);
  const frameTotal = timing.pcntPerLine * timing.vtotal;
  const windows: Array<{ start: number; end: number }> = [];
  for (let frame = 0; frame < Math.max(1, frameWindow); frame += 1) {
    const frameStart = frame * frameTotal;
    const start = frameStart + absPcnt(gpo.regionVst, gpo.regionPst, timing.pcntPerLine);
    const end = frameStart + absPcnt(gpo.regionVend, gpo.regionPend, timing.pcntPerLine);
    if (end <= start) continue;
    windows.push({ start: clamp(start, 0, total), end: clamp(end, 0, total) });
  }
  return windows.filter((window) => window.end > window.start);
}

function applyCombin(type: CombinType, own: Segment[], other: Segment[], total: number): Segment[] {
  if (type === 0) return own;
  if (type === 7) return other.length > 0 ? other : own;
  if (type === 4) return own.map((s) => ({ ...s, level: invert(s.level), source: `${s.source}:not` }));
  if (type === 5) return [{ start: 0, end: total, level: 1, source: 'combin-hi' }];
  if (type === 6) return [{ start: 0, end: total, level: 0, source: 'combin-low' }];

  const cuts = new Set<number>([0, total]);
  for (const s of own) { cuts.add(s.start); cuts.add(s.end); }
  for (const s of other) { cuts.add(s.start); cuts.add(s.end); }
  const points = [...cuts].filter((p) => p >= 0 && p <= total).sort((a, b) => a - b);
  const out: Segment[] = [];
  let iOwn = 0;
  let iOther = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === end) continue;
    while (own[iOwn + 1] && own[iOwn].end <= start) iOwn += 1;
    while (other[iOther + 1] && other[iOther].end <= start) iOther += 1;
    const a = own[iOwn]?.start <= start && own[iOwn]?.end > start ? own[iOwn].level : 0;
    const b = other[iOther]?.start <= start && other[iOther]?.end > start ? other[iOther].level : 0;
    out.push({ start, end, level: combineLevel(type, a, b), source: `combin-${type}` });
  }
  return normalizeSegments(out, total);
}

function combineLevel(type: CombinType, a: LogicLevel, b: LogicLevel): LogicLevel {
  if (type === 1) return (a && b ? 1 : 0) as LogicLevel;
  if (type === 2) return (a || b ? 1 : 0) as LogicLevel;
  if (type === 3) return (a !== b ? 1 : 0) as LogicLevel;
  return a;
}

function normalizeSegments(segments: Segment[], total: number): Segment[] {
  const clipped = segments
    .map((s) => ({ ...s, start: clamp(Math.round(s.start), 0, total), end: clamp(Math.round(s.end), 0, total) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const segment of clipped) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === segment.start && prev.level === segment.level && prev.source === segment.source) {
      prev.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function makeSignal(id: string, name: string, kind: SignalTrace['kind'], segments: Segment[], gpoIndex?: number): SignalTrace {
  return {
    id,
    name,
    kind,
    segments,
    edges: extractEdges(id, name, segments, gpoIndex),
    sourceGpo: gpoIndex,
    color: COLORS[(gpoIndex ?? 0) % COLORS.length],
  };
}

function extractEdges(signalId: string, signalName: string, segments: Segment[], gpoIndex?: number): Edge[] {
  const edges: Edge[] = [];
  let prevLevel: LogicLevel = 0;
  for (const segment of segments) {
    if (segment.start > 0 && segment.level !== prevLevel) {
      edges.push({
        id: `${signalId}@${segment.start}:${segment.level}`,
        signalId,
        signalName,
        at: segment.start,
        edge: segment.level ? 'rising' : 'falling',
        level: segment.level,
        source: segment.source,
        gpoIndex,
      });
    }
    prevLevel = segment.level;
  }
  return edges;
}

function detectFamilies(gpos: GpoConfig[]): SignalFamily[] {
  const textOf = (g: GpoConfig) => `${g.group} ${g.label}`.replace(/[_-]+/g, ' ');
  const byText = (patterns: RegExp[]) => gpos.find((g) => patterns.some((p) => p.test(textOf(g))));
  const byPredicate = (predicate: (g: GpoConfig, text: string) => boolean) => gpos.find((g) => predicate(g, textOf(g)));
  const hasToken = (text: string, token: string) => new RegExp(`(^|\\s)${token}(\\s|$)`, 'i').test(text);
  const isInitTpText = (text: string) => /(int|init|tcon)/i.test(text);
  const isCpvText = (text: string) => /(cpv1|cpv2|cvp1|cvp2|\bclk\s*1\b|\bclk\s*2\b)/i.test(text);
  const driverRaw =
    byText([/tp\s*for\s*driver/i, /driver\s*tp(?!.*merge)/i]) ??
    byPredicate((_g, text) => hasToken(text, 'tp') && !/merge|stv|pol|rst/i.test(text) && !isInitTpText(text) && !isCpvText(text));
  const driverSource =
    byText([/driver\s*tp.*merge/i]) ??
    byPredicate((_g, text) => hasToken(text, 'tp') && /merge/i.test(text) && !isInitTpText(text) && !isCpvText(text));
  const make = (id: SignalFamily['id'], label: string, gpo?: GpoConfig, namedSource?: GpoConfig): SignalFamily => ({
    id,
    label,
    rawGpo: gpo?.index,
    sourceGpo: gpo && gpo.combinType !== 0 ? gpo.combinSel : namedSource?.index,
    rawSignalId: gpo ? `gpo${gpo.index}:raw` : undefined,
    sourceSignalId: gpo && gpo.combinType !== 0 ? `gpo${gpo.combinSel}:raw` : namedSource ? `gpo${namedSource.index}:raw` : undefined,
    mergeSignalId: gpo ? `gpo${gpo.index}:merge` : undefined,
  });
  return [
    make('driver_tp', 'Driver_TP', driverRaw, driverSource),
    make('init_tp', 'Init_TP', byText([/int\s*tp\s*for\s*tcon/i, /init\s*tp(?!.*merge)/i, /int\s*tp(?!.*merge)/i]), byText([/int\s*tp.*merge/i, /init\s*tp.*merge/i])),
    make('stv', 'STV', byText([/stv/i])),
    make('cpv1', 'CPV1', byText([/(cpv1|cvp1|\bclk\s*1\b)(?!.*merge)/i]), byText([/(cpv1|cvp1|\bclk\s*1\b).*merge/i])),
    make('cpv2', 'CPV2', byText([/(cpv2|cvp2|\bclk\s*2\b)(?!.*merge)/i]), byText([/(cpv2|cvp2|\bclk\s*2\b).*merge/i])),
    make('pol', 'POL', byText([/int\s*pol\b/i, /\bpol\b/i])),
    make('lc', 'LC', byText([/(^|\s)lc(\s|$)/i, /vgpin/i])),
  ];
}

function buildDisplaySignals(families: SignalFamily[], raw: Map<number, SignalTrace>, merge: Map<number, SignalTrace>, rstGpo?: number): SignalTrace[] {
  const out: SignalTrace[] = [];
  for (const family of families) {
    if (family.rawGpo !== undefined) {
      const rawSignal = raw.get(family.rawGpo);
      if (rawSignal) out.push({ ...rawSignal, id: `${family.id}:raw`, name: `${family.label} raw` });
      if (family.sourceGpo !== undefined) {
        const source = raw.get(family.sourceGpo);
        if (source) out.push({ ...source, id: `${family.id}:source`, name: `${family.label} merge`, kind: 'source' });
      }
      const merged = merge.get(family.rawGpo);
      if (merged) out.push({ ...merged, id: `${family.id}:merge`, name: `${family.label} out` });
    }
  }
  if (rstGpo !== undefined) {
    const rst = merge.get(rstGpo) ?? raw.get(rstGpo);
    if (rst) out.push({ ...rst, id: 'rst:manual', name: 'RST out', kind: 'manual' });
  }
  return out.map((signal) => ({ ...signal, edges: extractEdges(signal.id, signal.name, signal.segments, signal.sourceGpo) }));
}

function buildGpoSignals(gpos: GpoConfig[], raw: Map<number, SignalTrace>, merge: Map<number, SignalTrace>): SignalTrace[] {
  const out: SignalTrace[] = [];
  for (const gpo of gpos) {
    const rawSignal = raw.get(gpo.index);
    if (rawSignal) out.push({ ...rawSignal, id: `gpo:${gpo.index}:raw`, name: `${gpo.group} raw`, kind: 'manual' });
    const mergeSignal = merge.get(gpo.index);
    if (mergeSignal) out.push({ ...mergeSignal, id: `gpo:${gpo.index}:merge`, name: `${gpo.group} out`, kind: 'manual' });
  }
  return out.map((signal) => ({ ...signal, edges: extractEdges(signal.id, signal.name, signal.segments, signal.sourceGpo) }));
}

function inferTerCpv2(cpv2GpoIndex: number | undefined, gpos: GpoConfig[], ocpSel: string): TerCpv2Inference {
  const cpv2 = gpos.find((g) => g.index === cpv2GpoIndex);
  if (!cpv2) return { role: 'UNKNOWN', severity: 'warn', message: '未找到 CPV2 GPO，无法判定 TER/CPV2 复用。' };
  const ocpIsOne = ocpSel === '1';
  if (cpv2.repeatMode === 0 && ocpIsOne) return { role: 'CPV2', severity: 'ok', message: 'CPV2 Repeat_mode_SEL=0 且 OCP_SEL=1：该脚作为 CPV2/CKI2，进入二进多出模式。' };
  if (cpv2.repeatMode === 1 && !ocpIsOne) return { role: 'TER', severity: 'ok', message: 'CPV2 Repeat_mode_SEL=1 且 OCP_SEL!=1：该脚作为 TER。' };
  if (cpv2.repeatMode === 1 && ocpIsOne) return { role: 'ERROR', severity: 'error', message: 'CPV2 Repeat_mode_SEL=1 且 OCP_SEL=1：frame 刷新与二进八出模式逻辑不匹配。' };
  return { role: 'UNKNOWN', severity: 'warn', message: 'CPV2 Repeat_mode_SEL=0 且 OCP_SEL!=1：不静默猜，请确认 level shifter 模式。' };
}

function simulateEk86707aPreview(config: Ek86707aConfig, signals: SignalTrace[], gpoSignals: SignalTrace[], inference: TerCpv2Inference, timing: TimingBase): SignalTrace[] {
  const all = [...signals, ...gpoSignals];
  const mapped = (id: string | undefined) => id ? all.find((signal) => signal.id === id) : undefined;
  const cki1 = mapped(config.inputs.cpv1) ?? signals.find((s) => s.id === 'cpv1:merge');
  const stv = mapped(config.inputs.stv) ?? signals.find((s) => s.id === 'stv:merge');
  const cpv2 = mapped(config.inputs.cpv2) ?? signals.find((s) => s.id === 'cpv2:merge');
  if (!cki1) return [];
  const total = timing.pcntPerLine * timing.vtotal;
  const count = ek86707aSet1OutputCount(config.set1);
  const startAt = risingTimesOf(stv, total)[0] ?? 0;
  const cki1Rises = risingTimesOf(cki1, total).filter((at) => at >= startAt);
  const cki2Rises = risingTimesOf(cpv2, total).filter((at) => at >= startAt);
  const twoInputMode = config.ocpSel === '1' && inference.role === 'CPV2' && cki2Rises.length > 0;

  if (twoInputMode) {
    const highs: Segment[][] = Array.from({ length: count }, () => []);
    let fallCursor = 0;
    for (let slot = 0; slot < cki1Rises.length; slot += 1) {
      const start = cki1Rises[slot];
      while (fallCursor < cki2Rises.length && cki2Rises[fallCursor] <= start) fallCursor += 1;
      const end = cki2Rises[fallCursor];
      if (end === undefined) break;
      if (end > start) highs[slot % count].push({ start, end, level: 1, source: 'ek86707a-2input' });
      fallCursor += 1;
    }
    const note = '单 EK86707A preview：OCP_SEL=1 二进多出；CPV1=CKI1 上升沿拉高当前 CKO，CPV2=CKI2 上升沿定义下降沿，phase 按 CKI1 rising 轮转。';
    return makeEkClockTraces(highs, count, total, note);
  }

  const terminateAt = inference.role === 'TER' ? cki2Rises.find((at) => at > startAt) : undefined;
  const risingEdges = cki1Rises.filter((at) => terminateAt === undefined || at < terminateAt);
  const fallingEdges = fallingTimesOf(cki1, total).filter((at) => at >= startAt && (terminateAt === undefined || at < terminateAt));
  const highs: Segment[][] = Array.from({ length: count }, () => []);
  addEkSingleInputWindows(highs, risingEdges, fallingEdges, 0, 1, count, config, terminateAt, total, 'ek86707a-1input');
  const note = cki2Rises.length === 0 && config.ocpSel === '1' && inference.role === 'CPV2'
    ? '单 EK86707A preview：OCP_SEL=1 但 CPV2/CKI2 没有可用 rising edge，无法生成二进多出窗口，请检查 CPV2 输入映射。'
    : `单 EK86707A preview：CPV1/CKI1 rising 触发；${ekPreviewModeNote(config)}；TER rising 清零。`;
  return makeEkClockTraces(highs, count, total, note);
}

function simulateDualEk86707aPreview(config: DualEk86707aConfig, signals: SignalTrace[], gpoSignals: SignalTrace[], timing: TimingBase): SignalTrace[] {
  const all = [...signals, ...gpoSignals];
  const mapped = (id: string | undefined) => id ? all.find((signal) => signal.id === id) : undefined;
  const oddCki = mapped(config.inputs.cpv1) ?? signals.find((s) => s.id === 'cpv1:merge');
  const evenCki = mapped(config.inputs.cpv2) ?? signals.find((s) => s.id === 'cpv2:merge');
  const stv = mapped(config.inputs.stv) ?? signals.find((s) => s.id === 'stv:merge');
  const ter = mapped(config.inputs.ter) ?? signals.find((s) => s.id === 'ter:manual');
  if (!oddCki && !evenCki) return [];

  const total = timing.pcntPerLine * timing.vtotal;
  const perChipCount = ek86707aSet1OutputCount(config.set1);
  const count = perChipCount * 2;
  const startAt = risingTimesOf(stv, total)[0] ?? 0;
  const terminateAt = risingTimesOf(ter, total).find((at) => at > startAt);
  const highs: Segment[][] = Array.from({ length: count }, () => []);
  addDualEkOneChipWindows(highs, oddCki, 0, perChipCount, config, startAt, terminateAt, total, 'dual-ek86707a-odd');
  addDualEkOneChipWindows(highs, evenCki, 1, perChipCount, config, startAt, terminateAt, total, 'dual-ek86707a-even');
  return makeEkClockTraces(highs, count, total, `双 EK86707A preview：配置共用；CPV1驱动奇数CKO、CPV2驱动偶数CKO；${ekPreviewModeNote(config)}；TER rising 共用清两颗输出。`);
}

function addDualEkOneChipWindows(
  highs: Segment[][],
  input: SignalTrace | undefined,
  phaseOffset: 0 | 1,
  perChipCount: number,
  config: Ek86707aCommonConfig,
  startAt: number,
  terminateAt: number | undefined,
  total: number,
  source: string,
): void {
  const risingEdges = risingTimesOf(input, total).filter((at) => at >= startAt && (terminateAt === undefined || at < terminateAt));
  const fallingEdges = fallingTimesOf(input, total).filter((at) => at >= startAt && (terminateAt === undefined || at < terminateAt));
  addEkSingleInputWindows(highs, risingEdges, fallingEdges, phaseOffset, 2, perChipCount, config, terminateAt, total, source);
}

function addEkSingleInputWindows(
  highs: Segment[][],
  risingEdges: number[],
  fallingEdges: number[],
  phaseOffset: number,
  channelStride: number,
  phaseCount: number,
  config: Ek86707aCommonConfig,
  terminateAt: number | undefined,
  total: number,
  source: string,
): void {
  const holdIntervals = ekHoldIntervals(config);
  for (let slot = 0; slot < risingEdges.length; slot += 1) {
    const start = risingEdges[slot];
    const end = ekSingleInputWindowEnd(risingEdges, fallingEdges, slot, holdIntervals, config, terminateAt, total);
    if (end <= start) continue;
    const phase = slot % phaseCount;
    const channel = phase * channelStride + phaseOffset;
    highs[channel]?.push({ start, end, level: 1, source });
  }
}

function ekSingleInputWindowEnd(
  risingEdges: number[],
  fallingEdges: number[],
  slot: number,
  holdIntervals: number,
  config: Ek86707aCommonConfig,
  terminateAt: number | undefined,
  total: number,
): number {
  const start = risingEdges[slot];
  const noIntervalEnd = risingEdges[slot + holdIntervals] ?? terminateAt ?? total;
  const lastRiseIndex = Math.min(slot + holdIntervals - 1, risingEdges.length - 1);
  const lastRiseBeforeEnd = risingEdges[lastRiseIndex] ?? start;
  const nextFalling = firstEdgeAfter(fallingEdges, lastRiseBeforeEnd, noIntervalEnd);
  const intervalEnd = nextFalling ?? Math.floor((lastRiseBeforeEnd + noIntervalEnd) / 2);
  return Math.min(config.set2 ? intervalEnd : noIntervalEnd, terminateAt ?? total, total);
}

function firstEdgeAfter(edges: number[], after: number, before: number): number | undefined {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (edges[mid] <= after) lo = mid + 1;
    else hi = mid;
  }
  const edge = edges[lo];
  return edge !== undefined && edge < before ? edge : undefined;
}

function ekHoldIntervals(config: Ek86707aCommonConfig): number {
  if (config.mode2 === '1') return config.set3 ? 2 : 4;
  if (config.mode1 === 'extra-high') return 4;
  if (config.mode1 === 'low') return 3;
  if (config.mode1 === 'high') return 2;
  return 1;
}

function ekPreviewModeNote(config: Ek86707aCommonConfig): string {
  const interval = config.set2 ? 'SET2=HIGH 有time interval' : 'SET2=LOW/FLOAT 无time interval';
  if (config.mode2 === '1') return `${interval}；MODE2=HIGH，${config.set3 ? 'SET3=HIGH 2-line on' : 'SET3=LOW 4-line on'}`;
  return `${interval}；MODE2=LOW，${ekMode1Note(config.mode1)}`;
}

function ekMode1Note(mode1: Ek86707aCommonConfig['mode1']): string {
  if (mode1 === 'extra-high') return 'MODE1=ExtraHigh 3-line pre-charge，CK保持4个CKI interval';
  if (mode1 === 'low') return 'MODE1=Low 2-line pre-charge，CK保持3个CKI interval';
  if (mode1 === 'high') return 'MODE1=High 1-line pre-charge，CK保持2个CKI interval';
  return 'MODE1=Middle no pre-charge，主CK只保持当前相位';
}

function makeEkClockTraces(highs: Segment[][], count: number, total: number, note: string): SignalTrace[] {
  const traces: SignalTrace[] = [];
  for (let ch = 0; ch < count; ch += 1) {
    const segments = highPulsesToSegments(highs[ch] ?? [], total, 'ek86707a-low');
    traces.push({
      ...makeSignal(`ck${ch + 1}`, `CK${ch + 1} / CKO_${ch + 1}`, 'ck', segments, undefined),
      color: CK_COLORS[ch % CK_COLORS.length],
      readonly: true,
      note,
    });
  }
  return traces;
}

function simulateIml7272bPreview(config: Iml7272bConfig, signals: SignalTrace[], gpoSignals: SignalTrace[], timing: TimingBase, warnings: string[]): SignalTrace[] {
  const total = timing.pcntPerLine * timing.vtotal;
  const all = [...signals, ...gpoSignals];
  const input = (id: string | undefined, name: string) => {
    const signal = id ? all.find((item) => item.id === id) : undefined;
    if (!signal) warnings.push(`iML7272B: ${name} 尚未映射，相关 LS 输出保持 LOW。`);
    return signal;
  };
  const stvIn1 = input(config.inputs.stvIn1, 'STV_IN1');
  const stvIn2 = input(config.inputs.stvIn2, 'STV_IN2');
  const clkIn1 = input(config.inputs.clkIn1, 'CLK_IN1');
  const clkIn2 = input(config.inputs.clkIn2, 'CLK_IN2');
  const lcIn = input(config.inputs.lcIn, 'LC_IN');
  const terminate = input(config.inputs.terminate, 'Terminate');
  const phaseCount = imlPhaseCount(config);
  const mode = imlClockMode(config);
  const outputs: SignalTrace[] = [];

  outputs.push(makeLsSignal('ls:stv1', 'LS STV1', stvIn1?.segments ?? lowSegments(total), total, '#7fa6bd'));
  outputs.push(makeLsSignal('ls:stv2', 'LS STV2', stvIn2?.segments ?? lowSegments(total), total, '#b9a36d'));

  const lcSegments = lcIn?.segments ?? lowSegments(total);
  const lcMode = config.reg01 & 0x03;
  outputs.push(makeLsSignal('ls:lc1', 'LS LC1', lcMode === 0 || lcMode === 2 ? lcSegments : invertSegments(lcSegments), total, '#8ea77d'));
  outputs.push(makeLsSignal('ls:lc2', 'LS LC2', lcMode === 0 || lcMode === 3 ? lcSegments : invertSegments(lcSegments), total, '#b18463'));

  const clockSegments = expandImlClocks(clkIn1, clkIn2, terminate, phaseCount, mode, total);
  for (let i = 0; i < 10; i += 1) {
    outputs.push(makeLsSignal(`ls:clk${i + 1}`, `LS CLK${i + 1}`, clockSegments[i] ?? lowSegments(total), total, CK_COLORS[i % CK_COLORS.length]));
  }
  return outputs.map((signal) => ({
    ...signal,
    readonly: true,
    note: `iML7272B preview：${modeLabel(mode, phaseCount)}；CLK_IN1/2 高脉冲按 PDF 图谱路由到 LS CLKx，Terminate rising 只清输出，不清 phase counter。`,
  }));
}

function simulateEk86752bPreview(config: Ek86752bConfig, signals: SignalTrace[], gpoSignals: SignalTrace[], timing: TimingBase, warnings: string[]): SignalTrace[] {
  validateEk86752bConfig(config, warnings);
  const total = timing.pcntPerLine * timing.vtotal;
  const all = [...signals, ...gpoSignals];
  const input = (id: string | undefined, name: string, required: boolean) => {
    const signal = id ? all.find((item) => item.id === id) : undefined;
    if (!signal && required) warnings.push(`EK86752B: ${name} 尚未映射，相关 LS 输出保持 LOW。`);
    return signal;
  };

  const fourInput = ek52FourInput(config);
  const hsr = ek52Hsr(config);
  const lsEnabled = (config.reg08 & 0x80) !== 0;
  const stv1 = input(config.inputs.stv1, 'STV1', false);
  const stv2 = input(config.inputs.stv2, 'STV2', fourInput && ek52Stv12ClkCtrl(config));
  const reset = input(config.inputs.reset, 'RESET', false);
  const cpv1 = input(config.inputs.cpv1, 'CPV1', true);
  const cpv2 = input(config.inputs.cpv2, 'CPV2', true);
  const cpv3 = input(config.inputs.cpv3, 'CPV3', fourInput);
  const cpv4 = input(config.inputs.cpv4, 'CPV4', fourInput);
  const terminate = input(config.inputs.terminate, 'Terminate', false);
  const lcIn1 = input(config.inputs.lcIn1, 'LCIN1', false);
  const lcIn2 = input(config.inputs.lcIn2, 'LCIN2', hsr === 1);

  const outputs: SignalTrace[] = [];
  const disabled = !lsEnabled;
  if (disabled) warnings.push('EK86752B: LS_EN=0，当前预览把所有 LS 输出显示为 LOW；真实硬件为 output disable。');
  const signalOrLow = (signal: SignalTrace | undefined) => disabled ? lowSegments(total) : signal?.segments ?? lowSegments(total);

  outputs.push(makeLsSignal('ls:stv1', 'LS STVOUT1', signalOrLow(stv1), total, '#7fa6bd'));
  outputs.push(makeLsSignal('ls:stv2', 'LS STVOUT2', signalOrLow(stv2), total, '#b9a36d'));
  outputs.push(makeLsSignal('ls:resetout', 'LS RESETOUT', signalOrLow(reset), total, '#ad826b'));

  const lc1 = disabled ? lowSegments(total) : lcIn1?.segments ?? lowSegments(total);
  const lc2 = disabled
    ? lowSegments(total)
    : hsr === 1
      ? lcIn2?.segments ?? lowSegments(total)
      : lcIn1 ? invertSegments(lcIn1.segments) : lowSegments(total);
  outputs.push(makeLsSignal('ls:lc1', 'LS LCOUT1', lc1, total, '#8ea77d'));
  outputs.push(makeLsSignal('ls:lc2', 'LS LCOUT2', lc2, total, '#b18463'));

  const clockSegments = disabled
    ? Array.from({ length: 12 }, () => lowSegments(total))
    : fourInput
      ? expandEk52FourInputClocks(config, { stv1, stv2, reset, cpv1, cpv2, cpv3, cpv4 }, total)
      : expandEk52TwoInputClocks(config, { stv1, stv2, reset, cpv1, cpv2, terminate }, total);

  const phaseCount = ek52PhaseCount(config);
  for (let i = 0; i < 12; i += 1) {
    outputs.push(makeLsSignal(`ls:clk${i + 1}`, `LS CLKOUT${i + 1}`, clockSegments[i] ?? lowSegments(total), total, CK_COLORS[i % CK_COLORS.length]));
  }

  const mode = fourInput ? '4CPV' : '2CPV';
  const note = `EK86752B preview：${mode} / ${phaseCount} phase；${ek52Double(config) ? 'DOUBLE=1' : 'DOUBLE=0'}；${ek52Reverse(config) ? 'REVERSE=1' : 'REVERSE=0'}；DUMMY_CLK 仅保存提示。`;
  return outputs.map((signal) => ({ ...signal, readonly: true, note }));
}

type Ek52TwoInputSignals = {
  stv1?: SignalTrace;
  stv2?: SignalTrace;
  reset?: SignalTrace;
  cpv1?: SignalTrace;
  cpv2?: SignalTrace;
  terminate?: SignalTrace;
};

type Ek52FourInputSignals = {
  stv1?: SignalTrace;
  stv2?: SignalTrace;
  reset?: SignalTrace;
  cpv1?: SignalTrace;
  cpv2?: SignalTrace;
  cpv3?: SignalTrace;
  cpv4?: SignalTrace;
};
type Ek52Event = { at: number; type: string };
type Ek52ActiveChannels = ReturnType<typeof ek52ActiveChannels>;
type Ek52FourInputState = {
  oddIndex: number;
  evenIndex: number;
  oddArmed: boolean;
  evenArmed: boolean;
};

function expandEk52TwoInputClocks(config: Ek86752bConfig, signals: Ek52TwoInputSignals, total: number): Segment[][] {
  const sequence = ek52TwoInputSequence(config);
  const highs: Segment[][] = Array.from({ length: 12 }, () => []);
  const active = new Map<number, number>();
  const channels = ek52ActiveChannels(highs, active);
  let highIndex = 0;
  let lowIndex = 0;
  let armed = risingTimesOf(signals.stv1, total).length === 0;
  let inhibited = false;

  const events = ek52SortedEvents([
    ['stv1', risingTimesOf(signals.stv1, total)],
    ['stv2', risingTimesOf(signals.stv2, total)],
    ['reset', risingTimesOf(signals.reset, total)],
    ['high', ek52HighEvents(config, signals.cpv1, total)],
    ['low', ek52TwoInputLowEvents(config, signals.cpv2, total)],
    ['term', risingTimesOf(signals.terminate, total)],
  ]);

  for (const event of events) {
    if (event.type === 'stv1') {
      channels.closeAll(event.at, 'ek86752b-stv1-reset');
      highIndex = 0;
      lowIndex = 0;
      armed = true;
      inhibited = false;
      continue;
    }
    if (event.type === 'stv2' && ek52Stv2Reset(config)) {
      channels.closeAll(event.at, 'ek86752b-stv2-reset');
      continue;
    }
    if (event.type === 'reset' && ek52ResetOutReset(config)) {
      channels.closeAll(event.at, 'ek86752b-resetout-reset');
      continue;
    }
    if (event.type === 'term') {
      if (!ek52TermMode(config)) channels.closeAll(event.at, 'ek86752b-terminate');
      inhibited = true;
      continue;
    }
    if (!armed || inhibited || sequence.length === 0) continue;
    if (event.type === 'high') {
      const group = sequence[highIndex % sequence.length];
      channels.open(group, event.at);
      highIndex += 1;
      continue;
    }
    if (event.type === 'low') {
      const group = sequence[lowIndex % sequence.length];
      channels.close(group, event.at, 'ek86752b-2cpv');
      lowIndex += 1;
    }
  }
  channels.closeAll(total, 'ek86752b-frame-end');
  return highs.map((segments) => highPulsesToSegments(segments, total, 'ek86752b-low'));
}

function expandEk52FourInputClocks(config: Ek86752bConfig, signals: Ek52FourInputSignals, total: number): Segment[][] {
  const { odd, even } = ek52FourInputSequences(config);
  const highs: Segment[][] = Array.from({ length: 12 }, () => []);
  const active = new Map<number, number>();
  const channels = ek52ActiveChannels(highs, active);
  const stv12Ctrl = ek52Stv12ClkCtrl(config);
  const state: Ek52FourInputState = {
    oddIndex: 0,
    evenIndex: 0,
    oddArmed: risingTimesOf(signals.stv1, total).length === 0,
    evenArmed: stv12Ctrl ? risingTimesOf(signals.stv2, total).length === 0 : risingTimesOf(signals.stv1, total).length === 0,
  };

  const events = ek52SortedEvents([
    ['stv1', risingTimesOf(signals.stv1, total)],
    ['stv2', risingTimesOf(signals.stv2, total)],
    ['reset', risingTimesOf(signals.reset, total)],
    ['oddHigh', risingTimesOf(signals.cpv1, total)],
    ['oddLow', ek52LowEvents(config, signals.cpv2, total)],
    ['evenHigh', risingTimesOf(signals.cpv3, total)],
    ['evenLow', ek52LowEvents(config, signals.cpv4, total)],
  ]);

  for (const event of events) {
    applyEk52FourInputEvent(event, { odd, even }, state, channels, config, stv12Ctrl);
  }
  channels.closeAll(total, 'ek86752b-frame-end');
  return highs.map((segments) => highPulsesToSegments(segments, total, 'ek86752b-low'));
}

function applyEk52FourInputEvent(
  event: Ek52Event,
  sequences: { odd: number[][]; even: number[][] },
  state: Ek52FourInputState,
  channels: Ek52ActiveChannels,
  config: Ek86752bConfig,
  stv12Ctrl: boolean,
): void {
  if (event.type === 'stv1') return resetEk52OddSide(event.at, state, channels, config, stv12Ctrl);
  if (event.type === 'stv2') return resetEk52EvenSide(event.at, state, channels, config, stv12Ctrl);
  if (event.type === 'reset' && ek52ResetOutReset(config)) return channels.closeAll(event.at, 'ek86752b-resetout-reset');
  if (event.type === 'oddHigh') return openEk52Side(sequences.odd, state.oddIndex, state.oddArmed, event.at, channels);
  if (event.type === 'oddLow') state.oddIndex = closeEk52Side(sequences.odd, state.oddIndex, state.oddArmed, event.at, channels, 'ek86752b-4cpv-odd');
  if (event.type === 'evenHigh') return openEk52Side(sequences.even, state.evenIndex, state.evenArmed, event.at, channels);
  if (event.type === 'evenLow') state.evenIndex = closeEk52Side(sequences.even, state.evenIndex, state.evenArmed, event.at, channels, 'ek86752b-4cpv-even');
}

function resetEk52OddSide(at: number, state: Ek52FourInputState, channels: Ek52ActiveChannels, config: Ek86752bConfig, stv12Ctrl: boolean): void {
  if (ek52Stv1Reset(config)) channels.closeAll(at, 'ek86752b-stv1-reset');
  state.oddIndex = 0;
  state.oddArmed = true;
  if (!stv12Ctrl) {
    state.evenIndex = 0;
    state.evenArmed = true;
  }
}

function resetEk52EvenSide(at: number, state: Ek52FourInputState, channels: Ek52ActiveChannels, config: Ek86752bConfig, stv12Ctrl: boolean): void {
  if (ek52Stv2Reset(config)) channels.closeAll(at, 'ek86752b-stv2-reset');
  if (stv12Ctrl) {
    state.evenIndex = 0;
    state.evenArmed = true;
  }
}

function openEk52Side(sequence: number[][], index: number, armed: boolean, at: number, channels: Ek52ActiveChannels): void {
  if (armed && sequence.length > 0) channels.open(sequence[index % sequence.length], at);
}

function closeEk52Side(sequence: number[][], index: number, armed: boolean, at: number, channels: Ek52ActiveChannels, source: string): number {
  if (!armed || sequence.length === 0) return index;
  channels.close(sequence[index % sequence.length], at, source);
  return index + 1;
}

function ek52ActiveChannels(highs: Segment[][], active: Map<number, number>) {
  const close = (group: number[], at: number, source: string) => {
    for (const channel of group) {
      const start = active.get(channel);
      if (start !== undefined && at > start) highs[channel].push({ start, end: at, level: 1, source });
      active.delete(channel);
    }
  };
  return {
    open(group: number[], at: number) {
      for (const channel of group) {
        const existing = active.get(channel);
        if (existing !== undefined && at > existing) highs[channel].push({ start: existing, end: at, level: 1, source: 'ek86752b-overlap-close' });
        active.set(channel, at);
      }
    },
    close,
    closeAll(at: number, source: string) {
      close([...active.keys()], at, source);
    },
  };
}

function ek52SortedEvents(entries: Array<[string, number[]]>): Ek52Event[] {
  return entries
    .flatMap(([type, times]) => times.map((at) => ({ at, type })))
    .sort((a, b) => a.at - b.at || ek52EventRank(a.type) - ek52EventRank(b.type));
}

function ek52TwoInputSequence(config: Ek86752bConfig): number[][] {
  const phaseCount = ek52PhaseCount(config);
  let sequence: number[][];
  if (ek52Double(config)) {
    sequence = ek52En120Hz(config)
      ? ek52En120Pairs(phaseCount)
      : pairAdjacent(Array.from({ length: phaseCount }, (_unused, index) => index));
  } else {
    sequence = Array.from({ length: phaseCount }, (_unused, index) => [index]);
  }
  return ek52Reverse(config) ? [...sequence].reverse() : sequence;
}

function ek52FourInputSequences(config: Ek86752bConfig): { odd: number[][]; even: number[][] } {
  const phaseCount = ek52PhaseCount(config);
  const oddChannels = Array.from({ length: phaseCount }, (_unused, index) => index).filter((index) => index % 2 === 0);
  const evenChannels = Array.from({ length: phaseCount }, (_unused, index) => index).filter((index) => index % 2 === 1);
  let odd = ek52Double(config) ? pairAdjacent(oddChannels) : oddChannels.map((index) => [index]);
  let even = ek52Double(config) ? pairAdjacent(evenChannels) : evenChannels.map((index) => [index]);
  if (ek52Reverse(config)) {
    odd = [...odd].reverse();
    even = [...even].reverse();
  }
  return { odd, even };
}

function pairAdjacent(channels: number[]): number[][] {
  const pairs: number[][] = [];
  for (let i = 0; i < channels.length; i += 2) {
    pairs.push(channels.slice(i, i + 2));
  }
  return pairs;
}

function ek52En120Pairs(phaseCount: number): number[][] {
  const out: number[][] = [];
  for (let base = 0; base < phaseCount; base += 4) {
    const first = [base, base + 2].filter((index) => index < phaseCount);
    const second = [base + 1, base + 3].filter((index) => index < phaseCount);
    if (first.length > 0) out.push(first);
    if (second.length > 0) out.push(second);
  }
  return out;
}

function ek52HighEvents(config: Ek86752bConfig, signal: SignalTrace | undefined, total: number): number[] {
  return ek52Cpv12F2x(config) ? bothTimesOf(signal, total) : risingTimesOf(signal, total);
}

function ek52TwoInputLowEvents(config: Ek86752bConfig, signal: SignalTrace | undefined, total: number): number[] {
  // 0x03[0]=0: CPV2 low follows CLK_FALL_EDGE.
  // 0x03[0]=1: CPV2 rising/falling sequentially pull CLKOUT1~12 low.
  if (!ek52Cpv12F2x(config)) return ek52ClkFallEdge(config) ? risingTimesOf(signal, total) : fallingTimesOf(signal, total);
  return bothTimesOf(signal, total);
}

function ek52LowEvents(config: Ek86752bConfig, signal: SignalTrace | undefined, total: number): number[] {
  return ek52ClkFallEdge(config) ? risingTimesOf(signal, total) : fallingTimesOf(signal, total);
}

function bothTimesOf(signal: SignalTrace | undefined, total: number): number[] {
  return (signal?.edges ?? [])
    .filter((edge) => (edge.edge === 'rising' || edge.edge === 'falling') && edge.at >= 0 && edge.at <= total)
    .map((edge) => edge.at)
    .sort((a, b) => a - b);
}

function validateEk86752bConfig(config: Ek86752bConfig, warnings: string[]): void {
  const hsr = ek52Hsr(config);
  const cpvx = (config.reg06 & 0x01) !== 0;
  if (!cpvx && hsr >= 2) warnings.push('EK86752B: CPVX_SEL=0 但 HSR=010..111，HSR 指向 4-input，当前按 4CPV 预览并提示配置冲突。');
  if (cpvx && hsr <= 1) warnings.push('EK86752B: CPVX_SEL=1 但 HSR=000/001，CPVX 指向 4-input，当前按 4CPV 预览并提示配置冲突。');
  if (((config.reg04 >> 7) & 1) && !ek52Double(config)) warnings.push('EK86752B: EN_120HZ=1 需要 DOUBLE=1 才符合 PDF 图谱，当前预览忽略 120Hz pair。');
  if (ek52En120Hz(config) && (ek52PhaseCount(config) === 6 || ek52PhaseCount(config) === 10)) warnings.push('EK86752B: EN_120HZ=1 时 PDF 标注 6/10 phase NOT SUPPORT。');
  if (ek52DummyClk(config)) warnings.push('EK86752B: DUMMY_CLK=1 第一版只保存并提示，暂不移动 CK 相位。');
  const clkDis = (config.reg0a >> 6) & 0x03;
  const lcDis = (config.reg0a >> 4) & 0x03;
  const stvDis = (config.reg09 >> 4) & 0x0f;
  if (clkDis !== 0) warnings.push(`EK86752B: CLK_DIS=${clkDis.toString(2).padStart(2, '0')}，第一版仍画逻辑波形，请注意真实输出可能 VGL2/HiZ。`);
  if (lcDis !== 0) warnings.push(`EK86752B: LC_DIS=${lcDis.toString(2).padStart(2, '0')}，第一版仍画逻辑波形，请注意真实输出可能 VGL2/HiZ。`);
  if (stvDis !== 0) warnings.push('EK86752B: STV/RESETO disable bits 非默认，第一版仍画输入跟随波形，请注意真实输出可能 VGL2/HiZ。');
}

function ek52EventRank(type: string): number {
  if (type === 'stv1' || type === 'stv2' || type === 'reset' || type === 'term') return 0;
  if (type.endsWith('High') || type === 'high') return 1;
  return 2;
}

function ek52PhaseCount(config: Ek86752bConfig): 4 | 6 | 8 | 10 | 12 {
  const code = (config.reg0b >> 3) & 0x07;
  if (code === 0) return 4;
  if (code === 1) return 6;
  if (code === 2) return 8;
  if (code === 3) return 10;
  return 12;
}

function ek52Hsr(config: Ek86752bConfig): number { return (config.reg08 >> 4) & 0x07; }
function ek52FourInput(config: Ek86752bConfig): boolean { return (config.reg06 & 0x01) !== 0 || ek52Hsr(config) >= 2; }
function ek52Cpv12F2x(config: Ek86752bConfig): boolean { return (config.reg03 & 0x01) !== 0; }
function ek52Double(config: Ek86752bConfig): boolean { return (config.reg04 & 0x04) !== 0; }
function ek52Reverse(config: Ek86752bConfig): boolean { return (config.reg04 & 0x08) !== 0; }
function ek52DummyClk(config: Ek86752bConfig): boolean { return (config.reg04 & 0x20) !== 0; }
function ek52En120Hz(config: Ek86752bConfig): boolean { return (config.reg04 & 0x80) !== 0 && ek52Double(config); }
function ek52ClkFallEdge(config: Ek86752bConfig): boolean { return (config.reg06 & 0x80) !== 0; }
function ek52Stv2Reset(config: Ek86752bConfig): boolean { return (config.reg06 & 0x02) !== 0; }
function ek52ResetOutReset(config: Ek86752bConfig): boolean { return (config.reg06 & 0x04) !== 0; }
function ek52Stv12ClkCtrl(config: Ek86752bConfig): boolean { return (config.reg07 & 0x40) !== 0; }
function ek52TermMode(config: Ek86752bConfig): boolean { return (config.reg07 & 0x80) !== 0; }
function ek52Stv1Reset(config: Ek86752bConfig): boolean { return (config.reg0b & 0x40) !== 0; }

function imlPhaseCount(config: Iml7272bConfig): 4 | 6 | 8 | 10 {
  const code = config.reg04 & 0x03;
  if (code === 0) return 4;
  if (code === 1) return 6;
  if (code === 2) return 8;
  return 10;
}

function imlClockMode(config: Iml7272bConfig): 'one-line' | 'two-line-mode1' | 'two-line-mode2' | 'hsr1' | 'hsr2' {
  const hsr = (config.reg01 >> 4) & 0x03;
  if (hsr === 1) return 'hsr1';
  if (hsr === 2 || hsr === 3) return 'hsr2';
  if ((config.reg04 & 0x80) === 0) return 'one-line';
  return (config.reg01 & 0x08) === 0 ? 'two-line-mode1' : 'two-line-mode2';
}

function expandImlClocks(
  clkIn1: SignalTrace | undefined,
  clkIn2: SignalTrace | undefined,
  terminate: SignalTrace | undefined,
  phaseCount: number,
  mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2' | 'hsr1' | 'hsr2',
  total: number,
): Segment[][] {
  if (mode === 'one-line' || mode === 'two-line-mode1' || mode === 'two-line-mode2') {
    return expandImlNormalClocks(clkIn1, clkIn2, terminate, phaseCount, mode, total);
  }

  const terminateRises = (terminate?.edges ?? [])
    .filter((edge) => edge.edge === 'rising' && edge.at >= 0 && edge.at <= total)
    .map((edge) => edge.at)
    .sort((a, b) => a - b);
  const pulses = [
    ...positivePulsesOf(clkIn1, 'clk1', total),
    ...positivePulsesOf(clkIn2, 'clk2', total),
  ].sort((a, b) => a.start - b.start || sourceRank(a.sourceKey) - sourceRank(b.sourceKey));
  const highs: Segment[][] = Array.from({ length: 10 }, () => []);
  let slot = 0;
  for (const pulse of pulses) {
    const clearAt = terminateRises.find((at) => at > pulse.start && at < pulse.end);
    const end = clearAt ?? pulse.end;
    if (end <= pulse.start) {
      slot += 1;
      continue;
    }
    for (const index of imlChannelsForPulse(mode, phaseCount, slot)) {
      if (index >= 0 && index < phaseCount && index < 10) {
        highs[index].push({ start: pulse.start, end, level: 1, source: `iml7272b-${mode}-${pulse.sourceKey}` });
      }
    }
    slot += 1;
  }
  return highs.map((segments, index) => index < phaseCount ? highPulsesToSegments(segments, total) : lowSegments(total));
}

function expandImlNormalClocks(
  clkIn1: SignalTrace | undefined,
  clkIn2: SignalTrace | undefined,
  terminate: SignalTrace | undefined,
  phaseCount: number,
  mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2',
  total: number,
): Segment[][] {
  const starts = risingTimesOf(clkIn1, total);
  const ends = risingTimesOf(clkIn2, total);
  const terminateRises = risingTimesOf(terminate, total);
  const highs: Segment[][] = Array.from({ length: 10 }, () => []);
  let endCursor = 0;

  for (let slot = 0; slot < starts.length; slot += 1) {
    const start = starts[slot];
    while (endCursor < ends.length && ends[endCursor] <= start) endCursor += 1;
    const nominalEnd = ends[endCursor];
    if (nominalEnd === undefined) break;
    const clearAt = terminateRises.find((at) => at > start && at < nominalEnd);
    const end = clearAt ?? nominalEnd;
    if (end > start) {
      for (const index of imlChannelsForNormalWindow(mode, phaseCount, slot)) {
        highs[index].push({ start, end, level: 1, source: `iml7272b-${mode}-rising-pair` });
      }
    }
    endCursor += 1;
  }

  return highs.map((segments, index) => index < phaseCount ? highPulsesToSegments(segments, total) : lowSegments(total));
}

function risingTimesOf(signal: SignalTrace | undefined, total: number): number[] {
  return (signal?.edges ?? [])
    .filter((edge) => edge.edge === 'rising' && edge.at >= 0 && edge.at <= total)
    .map((edge) => edge.at)
    .sort((a, b) => a - b);
}

function fallingTimesOf(signal: SignalTrace | undefined, total: number): number[] {
  return (signal?.edges ?? [])
    .filter((edge) => edge.edge === 'falling' && edge.at >= 0 && edge.at <= total)
    .map((edge) => edge.at)
    .sort((a, b) => a - b);
}

type ImlPulse = { start: number; end: number; sourceKey: 'clk1' | 'clk2' };

function positivePulsesOf(signal: SignalTrace | undefined, sourceKey: ImlPulse['sourceKey'], total: number): ImlPulse[] {
  return (signal?.segments ?? [])
    .filter((segment) => segment.level === 1)
    .map((segment) => ({
      start: clamp(segment.start, 0, total),
      end: clamp(segment.end, 0, total),
      sourceKey,
    }))
    .filter((pulse) => pulse.end > pulse.start);
}

function sourceRank(sourceKey: string): number {
  if (sourceKey === 'clk1') return 1;
  return 2;
}

function imlChannelsForNormalWindow(mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2', phaseCount: number, slot: number): number[] {
  if (mode === 'one-line') return [slot % phaseCount];
  return imlTwoLineChannels(mode, phaseCount, slot, true);
}

function imlChannelsForPulse(
  mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2' | 'hsr1' | 'hsr2',
  phaseCount: number,
  slot: number,
): number[] {
  if (mode === 'one-line') return [slot % phaseCount];
  if (mode === 'two-line-mode1' || mode === 'two-line-mode2') return imlTwoLineChannels(mode, phaseCount, slot, false);
  if (mode === 'hsr1') return [oddEvenPhaseOrder(phaseCount)[slot % phaseCount]];
  return [slot % phaseCount];
}

function imlTwoLineChannels(mode: 'two-line-mode1' | 'two-line-mode2', phaseCount: number, slot: number, clampToPhase: boolean): number[] {
  const pairCount = Math.max(1, Math.floor(phaseCount / 2));
  const pair = slot % pairCount;
  const channels = mode === 'two-line-mode1' ? [pair * 2, pair * 2 + 1] : [pair, pair + pairCount];
  return clampToPhase ? channels.filter((index) => index < phaseCount) : channels;
}

function oddEvenPhaseOrder(phaseCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < phaseCount; i += 2) out.push(i);
  for (let i = 1; i < phaseCount; i += 2) out.push(i);
  return out;
}

function highPulsesToSegments(highs: Segment[], total: number, lowSource = 'iml7272b-low'): Segment[] {
  const clipped = highs
    .map((segment) => ({ ...segment, start: clamp(segment.start, 0, total), end: clamp(segment.end, 0, total), level: 1 as LogicLevel }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const mergedHighs: Segment[] = [];
  for (const segment of clipped) {
    const prev = mergedHighs[mergedHighs.length - 1];
    if (prev && segment.start <= prev.end) prev.end = Math.max(prev.end, segment.end);
    else mergedHighs.push({ ...segment });
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (const high of mergedHighs) {
    if (high.start > cursor) out.push({ start: cursor, end: high.start, level: 0, source: lowSource });
    out.push(high);
    cursor = high.end;
  }
  if (cursor < total) out.push({ start: cursor, end: total, level: 0, source: lowSource });
  return out;
}

function modeLabel(mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2' | 'hsr1' | 'hsr2', phaseCount: number): string {
  const modeText = mode === 'one-line' ? '1-Line' : mode === 'two-line-mode1' ? '2-Line Mode1' : mode === 'two-line-mode2' ? '2-Line Mode2' : mode.toUpperCase();
  return `2-In ${phaseCount}-Out ${modeText}`;
}

function makeLsSignal(id: string, name: string, segments: Segment[], total: number, color: string): SignalTrace {
  const normalized = normalizeSegments(segments, total);
  return {
    id,
    name,
    kind: 'ck',
    segments: normalized,
    edges: extractEdges(id, name, normalized),
    color,
  };
}

function lowSegments(total: number): Segment[] {
  return [{ start: 0, end: total, level: 0, source: 'iml7272b-unmapped' }];
}

function invertSegments(segments: Segment[]): Segment[] {
  return segments.map((segment) => ({ ...segment, level: invert(segment.level), source: `${segment.source ?? 'signal'}:invert` }));
}

function resolveMeasurement(measurement: Measurement, edges: Edge[], timing: TimingBase): MeasurementResult {
  const startEdge = resolveMeasurementEdge(measurement.startEdgeId, measurement.startPoint, edges);
  const endEdge = resolveMeasurementEdge(measurement.endEdgeId, measurement.endPoint, edges);
  if (!startEdge || !endEdge) return { ...measurement, startEdge, endEdge };
  const deltaPcnt = endEdge.at - startEdge.at;
  const seconds = deltaPcnt * timing.pcntSeconds;
  if (measurement.targetSeconds === undefined) return { ...measurement, startEdge, endEdge, deltaPcnt, seconds };
  const errorSeconds = seconds - measurement.targetSeconds;
  const errorPcnt = Math.round(errorSeconds / timing.pcntSeconds);
  return {
    ...measurement,
    startEdge,
    endEdge,
    deltaPcnt,
    seconds,
    errorSeconds,
    errorPcnt,
    errorLcnt: Math.trunc(errorPcnt / timing.pcntPerLine),
    errorRemainderPcnt: errorPcnt % timing.pcntPerLine,
  };
}

function resolveMeasurementEdge(edgeId: string, snapshot: Edge | undefined, edges: Edge[]): Edge | undefined {
  const exact = edges.find((edge) => edge.id === edgeId);
  if (exact) return exact;
  if (!snapshot) return undefined;
  const candidates = edges.filter((edge) => (
    edge.signalId === snapshot.signalId
    && edge.edge === snapshot.edge
    && edge.level === snapshot.level
  ));
  if (candidates.length === 0) return snapshot;
  return candidates.reduce((best, edge) => (Math.abs(edge.at - snapshot.at) < Math.abs(best.at - snapshot.at) ? edge : best), candidates[0]);
}

function validateGpos(gpos: GpoConfig[], timing: TimingBase): string[] {
  const warnings: string[] = [];
  for (const gpo of gpos) {
    if (gpo.maskEnabled) {
      const start = absPcnt(gpo.regionVst, gpo.regionPst, timing.pcntPerLine);
      const end = absPcnt(gpo.regionVend, gpo.regionPend, timing.pcntPerLine);
      if (end <= start) warnings.push(`${gpo.group}: mask gate end <= start，Region_VST/PST 与 Region_VEND/PEND 组合无有效窗口。`);
    }
    for (const entry of gpo.entries) {
      if (entry.pcnt > timing.pcntMax) warnings.push(`${gpo.group} entry${entry.index}: PCNT=${formatCount4(entry.pcnt)} 超过 ${timing.soc === 'mt9603' ? 'MT9603 限制' : 'Htotal'}=${formatCount4(timing.pcntMax)}。`);
      if (gpo.repeatMode === 0 && gpo.soc !== 'mt9603' && entry.lcnt !== 0) warnings.push(`${gpo.group} entry${entry.index}: Repeat_mode_SEL=0(by line)，LCNT=${formatCount4(entry.lcnt)} 不应作为调参目标。`);
      if (gpo.repeatMode === 1 && entry.enabled && entry.frameCount > gpo.repeatCount) warnings.push(`${gpo.group} entry${entry.index}: Frame_cnt=${entry.frameCount} 超过 Repeat_Count_num=${gpo.repeatCount}。`);
    }
  }
  return warnings;
}

function invert(level: LogicLevel): LogicLevel { return level ? 0 : 1; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
