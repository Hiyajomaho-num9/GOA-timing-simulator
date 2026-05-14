import { defaultTpGeneratorConfig, ek86707aSet1OutputCount } from './types';
import type { CombinType, DraftProject, Edge, DualEk86707aConfig, Ek86707aConfig, Ek86707aCommonConfig, GpoConfig, Iml7272bConfig, LogicLevel, MeasurementResult, Segment, SignalFamily, SignalTrace, SimulationResult, TerCpv2Inference, TimingBase, TpGeneratorConfig } from './types';
import { absPcnt } from './time';

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
    : { role: 'UNKNOWN', severity: 'ok', message: project.levelShifter.model === 'single-iml7272b' ? 'iML7272B：TER/CPV2 复用规则不适用，输入由用户在 Level Shifter 参数页映射。' : '未启用 Level Shifter：仅显示 SoC GPO raw/out。' } satisfies TerCpv2Inference;
  const lsSignals = project.levelShifter.model === 'single-ek86707a'
    ? simulateEk86707aPreview(project.levelShifter, signals, gpoSignals, inference, timing)
    : project.levelShifter.model === 'dual-ek86707a'
      ? simulateDualEk86707aPreview(project.levelShifter, signals, gpoSignals, timing)
      : project.levelShifter.model === 'single-iml7272b'
        ? simulateIml7272bPreview(project.levelShifter, signals, gpoSignals, timing, warnings)
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
  const period = parseDurationToPcnt(config.driverTpPeriod, timing, timing.lcntSeconds);
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

export function simulateGpoBase(gpo: GpoConfig, timing: TimingBase, bypassMask: boolean): Segment[] {
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
  let level: LogicLevel = events.at(-1)?.entry.level ?? 0;
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
  const isCpvText = (text: string) => /(cpv1|cpv2|cvp1|cvp2)/i.test(text);
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
    make('cpv1', 'CPV1', byText([/cpv1(?!.*merge)/i]), byText([/cpv1.*merge/i])),
    make('cpv2', 'CPV2', byText([/cpv2(?!.*merge)/i]), byText([/(cpv2|cvp2).*merge/i])),
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

export function inferTerCpv2(cpv2GpoIndex: number | undefined, gpos: GpoConfig[], ocpSel: string): TerCpv2Inference {
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
  const holdIntervals = 4;
  const highs: Segment[][] = Array.from({ length: count }, () => []);
  for (let slot = 0; slot < risingEdges.length; slot += 1) {
    const start = risingEdges[slot];
    const nextHoldEdge = risingEdges[slot + holdIntervals];
    const end = Math.min(nextHoldEdge ?? terminateAt ?? total, terminateAt ?? total);
    if (end > start) highs[slot % count].push({ start, end, level: 1, source: 'ek86707a-1input' });
  }
  const note = cki2Rises.length === 0 && config.ocpSel === '1' && inference.role === 'CPV2'
    ? '单 EK86707A preview：OCP_SEL=1 但 CPV2/CKI2 没有可用 rising edge，无法生成二进多出窗口，请检查 CPV2 输入映射。'
    : '单 EK86707A preview：CPV1 rising edge 触发，相位轮转；extra-high 模式按 4 个 CKI rising interval 保持，TER 上升沿清零。';
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
  addDualEkOneChipWindows(highs, oddCki, 0, perChipCount, startAt, terminateAt, total, 'dual-ek86707a-odd');
  addDualEkOneChipWindows(highs, evenCki, 1, perChipCount, startAt, terminateAt, total, 'dual-ek86707a-even');
  return makeEkClockTraces(highs, count, total, '双 EK86707A preview：配置共用；CPV1 驱动奇数 CKO，CPV2 驱动偶数 CKO，TER rising 共用清两颗输出。');
}

function addDualEkOneChipWindows(
  highs: Segment[][],
  input: SignalTrace | undefined,
  phaseOffset: 0 | 1,
  perChipCount: number,
  startAt: number,
  terminateAt: number | undefined,
  total: number,
  source: string,
): void {
  const risingEdges = risingTimesOf(input, total).filter((at) => at >= startAt && (terminateAt === undefined || at < terminateAt));
  const holdIntervals = 4;
  for (let slot = 0; slot < risingEdges.length; slot += 1) {
    const start = risingEdges[slot];
    const nextHoldEdge = risingEdges[slot + holdIntervals];
    const end = Math.min(nextHoldEdge ?? terminateAt ?? total, terminateAt ?? total);
    if (end <= start) continue;
    const channel = (slot % perChipCount) * 2 + phaseOffset;
    highs[channel]?.push({ start, end, level: 1, source });
  }
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
  const pairCount = Math.max(1, Math.floor(phaseCount / 2));
  const pair = slot % pairCount;
  if (mode === 'two-line-mode1') return [pair * 2, pair * 2 + 1].filter((index) => index < phaseCount);
  return [pair, pair + pairCount].filter((index) => index < phaseCount);
}

function imlChannelsForPulse(
  mode: 'one-line' | 'two-line-mode1' | 'two-line-mode2' | 'hsr1' | 'hsr2',
  phaseCount: number,
  slot: number,
): number[] {
  if (mode === 'one-line') return [slot % phaseCount];
  const pairCount = Math.max(1, Math.floor(phaseCount / 2));
  const pair = slot % pairCount;
  if (mode === 'two-line-mode1') return [pair * 2, pair * 2 + 1];
  if (mode === 'two-line-mode2') return [pair, pair + pairCount];
  if (mode === 'hsr1') return [oddEvenPhaseOrder(phaseCount)[slot % phaseCount]];
  return [slot % phaseCount];
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

function resolveMeasurement(measurement: { id: string; startEdgeId: string; endEdgeId: string; targetSeconds?: number; notes?: string }, edges: Edge[], timing: TimingBase): MeasurementResult {
  const startEdge = edges.find((e) => e.id === measurement.startEdgeId);
  const endEdge = edges.find((e) => e.id === measurement.endEdgeId);
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

function validateGpos(gpos: GpoConfig[], timing: TimingBase): string[] {
  const warnings: string[] = [];
  for (const gpo of gpos) {
    if (gpo.maskEnabled) {
      const start = absPcnt(gpo.regionVst, gpo.regionPst, timing.pcntPerLine);
      const end = absPcnt(gpo.regionVend, gpo.regionPend, timing.pcntPerLine);
      if (end <= start) warnings.push(`${gpo.group}: mask gate end <= start，Region_VST/PST 与 Region_VEND/PEND 组合无有效窗口。`);
    }
    for (const entry of gpo.entries) {
      if (entry.pcnt > timing.pcntMax) warnings.push(`${gpo.group} entry${entry.index}: PCNT=${entry.pcnt} 超过 ${timing.soc === 'mt9603' ? 'MT9603 限制' : 'Htotal'}=${timing.pcntMax}。`);
      if (gpo.repeatMode === 0 && gpo.soc !== 'mt9603' && entry.lcnt !== 0) warnings.push(`${gpo.group} entry${entry.index}: Repeat_mode_SEL=0(by line)，LCNT=${entry.lcnt} 不应作为调参目标。`);
      if (gpo.repeatMode === 1 && entry.enabled && entry.frameCount > gpo.repeatCount) warnings.push(`${gpo.group} entry${entry.index}: Frame_cnt=${entry.frameCount} 超过 Repeat_Count_num=${gpo.repeatCount}。`);
    }
  }
  return warnings;
}

function invert(level: LogicLevel): LogicLevel { return level ? 0 : 1; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
