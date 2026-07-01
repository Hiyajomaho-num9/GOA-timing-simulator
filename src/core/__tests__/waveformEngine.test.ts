import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaveformEngine } from '../waveformEngine';
import { makeTimingBase } from '../time';
import { defaultLevelShifterConfig, type DraftProject, type GpoConfig, type GpoEntry } from '../types';

const timing = makeTimingBase(2170, 1140, 60); // htotal=2171, pcntPerLine=2171, vtotal=1140
const frameTotal = timing.pcntPerLine * timing.vtotal;

function entry(index: number, lcnt: number, pcnt: number, level: 0 | 1, opts: Partial<GpoEntry> = {}): GpoEntry {
  return { index, fcnt: 0, lcnt, pcnt, enabled: true, level, frameCount: 0, cells: {}, ...opts };
}

function baseGpo(over: Partial<GpoConfig> = {}): GpoConfig {
  return {
    index: 1,
    soc: 'mt9216',
    entryEncoding: 'packed-fcnt',
    code: 'GPO1',
    group: 'GPO1_TEST',
    label: 'TEST',
    combinType: 0,
    combinSel: 0,
    maskEnabled: false,
    regionVst: 0, regionVend: 0, regionPst: 0, regionPend: 0,
    regionOtherValue: 0,
    repeatCount: 0,
    repeatMode: 0,
    lineRepeatStartpoint: 0,
    perFrameInv: false,
    frameCntReset: false,
    entries: [],
    rows: [],
    cells: {},
    ...over,
  };
}

function levelAt(segs: { start: number; end: number; level: 0 | 1 }[], at: number): 0 | 1 {
  for (const s of segs) if (at >= s.start && at < s.end) return s.level;
  throw new Error(`no segment covers ${at}`);
}

function project(gpos: GpoConfig[]): DraftProject {
  return {
    timing,
    gpos,
    levelShifter: { model: 'none' },
    measurements: [],
    patches: [],
    dirty: false,
  };
}

test('querySignals exact: crops to the query window', () => {
  // high pulse [10, linePcnt*2) by carry across 2 lines
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  // query only [5, 50] within frame 0
  const res = eng.querySignals({ signalIds: [id], startPcnt: 5, endPcnt: 50, pixelWidth: 1600, mode: 'exact' });
  assert.ok(res.length > 0);
  assert.ok(res.every((s) => s.signalId === id));
  assert.ok(res.every((s) => s.start >= 5 && s.end <= 50));
  // [5,10) low, [10,50) high
  assert.equal(levelAt(res, 7), 0);
  assert.equal(levelAt(res, 20), 1);
});

test('querySignals exact: overview degrades to exact when segments <= pixelWidth', () => {
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  const exact = eng.querySignals({ signalIds: [id], startPcnt: 0, endPcnt: frameTotal, pixelWidth: 1600, mode: 'exact' });
  const overview = eng.querySignals({ signalIds: [id], startPcnt: 0, endPcnt: frameTotal, pixelWidth: 1600, mode: 'overview' });
  // few segments -> overview returns exact (no binning)
  assert.equal(exact.length, overview.length);
});

test('querySignals overview: bins to pixelWidth columns', () => {
  // many segments: alternate level every pcnt across a wide window won't work cheaply;
  // instead use a by-line entry that produces one transition, but query a huge window
  // with tiny pixelWidth to force binning. Use repeatCount to keep it bounded.
  const gpo = baseGpo({ index: 1, repeatMode: 0, repeatCount: 0, entries: [entry(0, 0, 5, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  // pixelWidth=4 forces aggressive binning over 1 frame
  const res = eng.querySignals({ signalIds: [id], startPcnt: 0, endPcnt: frameTotal, pixelWidth: 4, mode: 'overview' });
  // binned output is at most pixelWidth segments (after merge)
  assert.ok(res.length <= 4 + 1, `overview produced ${res.length} segments, expected <= 5`);
  assert.ok(res.every((s) => s.end > s.start));
});

test('querySignals exact: period-anchor keeps by-line carry in later frames', () => {
  // Last entry leaves carry high. Later frames must start steady-high after
  // the first repeated line; the period-anchor shortcut must not reset to low.
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  const start = frameTotal + timing.pcntPerLine + 1;
  const res = eng.querySignals({ signalIds: [id], startPcnt: start, endPcnt: start + 5, pixelWidth: 100, mode: 'exact' });
  assert.equal(levelAt(res, start + 1), 1);
});

test('nearestEdge: returns the closest edge within radius', () => {
  // rising edge at pcnt=10 (level 0 -> 1)
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  const edge = eng.nearestEdge({ signalId: id, at: 12, radiusPcnt: 100 });
  assert.ok(edge, 'expected a nearest edge');
  assert.equal(edge?.edge, 'rising');
  assert.equal(edge?.at, 10);
  assert.equal(edge?.signalId, id);
});

test('nearestEdge: returns undefined when no edge within radius', () => {
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  // query at pcnt 5000 with radius 5 — nearest edge is at 10, far outside radius
  const edge = eng.nearestEdge({ signalId: id, at: 5000, radiusPcnt: 5 });
  assert.equal(edge, undefined);
});

test('summarizeSignal by-frame: window-agnostic, derives W/T from entries', () => {
  // by-frame: one rising at frame0/lcnt0/pcnt0, one falling at frame0/lcnt0/pcnt=100
  const gpo = baseGpo({
    index: 2, group: 'GPO2_F', repeatMode: 1, repeatCount: 0,
    entries: [entry(0, 0, 0, 1, { frameCount: 0 }), entry(1, 0, 100, 0, { frameCount: 0 })],
  });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  // window-agnostic: same result regardless of window (as long as it's within the period)
  const s1 = eng.summarizeSignal(id, 0, frameTotal);
  const s2 = eng.summarizeSignal(id, frameTotal / 2, frameTotal);
  assert.equal(s1.firstWidthSeconds, s2.firstWidthSeconds, 'by-frame summary must be window-agnostic');
  assert.equal(s1.periodSeconds, s2.periodSeconds);
  // width = 100pcnt * pcntSeconds
  assert.ok(Math.abs((s1.firstWidthSeconds ?? 0) - 100 * timing.pcntSeconds) < 1e-15);
  // period = 1 frame
  assert.ok(Math.abs((s1.periodSeconds ?? 0) - frameTotal * timing.pcntSeconds) < 1e-12);
});

test('summarizeSignal generic: first pulse width + period from segments', () => {
  // by-line: high pulses via two entries on repeatLine 0 -> [10,30) high, [30,linePcnt) low, repeats per line
  const gpo = baseGpo({
    index: 3, repeatMode: 0, repeatCount: 0,
    entries: [entry(0, 0, 10, 1), entry(1, 0, 30, 0)],
  });
  const eng = createWaveformEngine(project([gpo]));
  const id = `gpo:${gpo.index}:merge`;
  const s = eng.summarizeSignal(id, 0, timing.pcntPerLine * 2);
  // first high pulse width = 20pcnt, period = one line
  assert.ok(Math.abs((s.firstWidthSeconds ?? 0) - 20 * timing.pcntSeconds) < 1e-15);
  assert.ok(Math.abs((s.periodSeconds ?? 0) - timing.pcntPerLine * timing.pcntSeconds) < 1e-12);
  assert.ok((s.pulseCount ?? 0) >= 1);
});

test('queryableSignalIds: covers family + gpo ids, excludes intermediate gpo${idx}:raw', () => {
  const stv = baseGpo({ index: 1, group: 'GPO1_STV', label: 'STV', repeatMode: 1, entries: [entry(0, 0, 0, 1)] });
  const eng = createWaveformEngine(project([stv]));
  const ids = new Set(eng.queryableSignalIds());
  assert.ok(ids.has('stv:raw'), 'family raw id exposed');
  assert.ok(ids.has('stv:merge'), 'family merge id exposed');
  assert.ok(ids.has('gpo:1:raw'), 'gpo output raw id exposed');
  assert.ok(ids.has('gpo:1:merge'), 'gpo output merge id exposed');
  // intermediate (no colon) must NOT be exposed
  assert.ok(!ids.has('gpo1:raw'), 'intermediate id must not be exposed');
});

test('querySignals: unknown signalId yields no segments (no throw)', () => {
  const gpo = baseGpo({ index: 1, repeatMode: 0, entries: [entry(0, 0, 10, 1)] });
  const eng = createWaveformEngine(project([gpo]));
  const res = eng.querySignals({ signalIds: ['does:not:exist'], startPcnt: 0, endPcnt: 100, pixelWidth: 100, mode: 'exact' });
  assert.equal(res.length, 0);
});

test('createWaveformEngine: throws when timing missing', () => {
  assert.throws(() => createWaveformEngine({ gpos: [], levelShifter: { model: 'none' }, measurements: [], patches: [], dirty: false }), /Timing base/);
});
