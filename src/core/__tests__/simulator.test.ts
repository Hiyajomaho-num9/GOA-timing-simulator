import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateGpoWindow, simulateGpoOutWindow, simulateProject } from '../simulator';
import { makeTimingBase } from '../time';
import { defaultLevelShifterConfig, type DraftProject, type GpoConfig, type GpoEntry } from '../types';

const timing = makeTimingBase(2170, 1140, 60); // htotal=2171, pcntPerLine=2171, vtotal=1140
const linePcnt = timing.pcntPerLine;

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

// helper: collect level at a given abs pcnt by scanning segments
function levelAt(segments: { start: number; end: number; level: 0 | 1 }[], at: number): 0 | 1 {
  for (const s of segments) if (at >= s.start && at < s.end) return s.level;
  throw new Error(`no segment covers ${at}`);
}

test('byLine: entry is a level switch point, carries to next line, no auto-zero at boundary', () => {
  // one entry at lcnt=0, pcnt=10 -> high; nothing else. Level should carry across lines.
  const gpo = baseGpo({
    repeatMode: 0,
    entries: [entry(0, 0, 10, 1)],
  });
  const segs = simulateGpoWindow(gpo, timing, true, 1);
  // line 0: low [0,10), high [10, linePcnt)
  assert.equal(levelAt(segs, 0), 0);
  assert.equal(levelAt(segs, 10), 1);
  // line 1 start: carry high into next line (no entry -> stays high)
  assert.equal(levelAt(segs, linePcnt + 5), 1);
});

test('byLine: Repeat_mode_SEL=0 ignores LCNT for tuning — entries on same repeatLine sort by pcnt', () => {
  const gpo = baseGpo({
    repeatMode: 0,
    repeatCount: 0, // periodLines = 1 -> every line uses repeatLine 0
    entries: [entry(1, 0, 30, 0), entry(0, 0, 10, 1)],
  });
  const segs = simulateGpoWindow(gpo, timing, true, 1);
  // both entries land on repeatLine 0, sorted by pcnt: low [0,10), high [10,30), low [30,...)
  assert.equal(levelAt(segs, 5), 0);
  assert.equal(levelAt(segs, 20), 1);
  assert.equal(levelAt(segs, 40), 0);
});

test('byFrame: entry triggers at frameCount*frameTotal + absPcnt(lcnt,pcnt)', () => {
  const frameTotal = linePcnt * timing.vtotal;
  const gpo = baseGpo({
    repeatMode: 1,
    repeatCount: 0, // periodFrames = 1
    entries: [entry(0, 1, 100, 1, { frameCount: 0 })],
  });
  const segs = simulateGpoWindow(gpo, timing, true, 1);
  // initial level = last entry level = 1 (since only one entry, level starts high)
  // Actually byFrame: initial cursor=0, level = last event level = 1 -> high from 0 until entry at
  const at = 1 * linePcnt + 100;
  // before entry: high (last entry level), at entry: switch to level 1 (same) -> stays high
  assert.equal(levelAt(segs, 0), 1);
  assert.equal(levelAt(segs, at - 5), 1);
  assert.equal(levelAt(segs, at + 5), 1);
});

test('byFrame: two entries produce a pulse window', () => {
  const gpo = baseGpo({
    repeatMode: 1,
    repeatCount: 0,
    entries: [entry(0, 0, 50, 1, { frameCount: 0 }), entry(1, 0, 200, 0, { frameCount: 0 })],
  });
  const segs = simulateGpoWindow(gpo, timing, true, 1);
  // initial level = last entry level = 0 -> low [0,50), high [50,200), low [200, total)
  assert.equal(levelAt(segs, 10), 0);
  assert.equal(levelAt(segs, 100), 1);
  assert.equal(levelAt(segs, 250), 0);
});

test('perFrameInv: inverts every segment level', () => {
  const gpo = baseGpo({
    repeatMode: 0,
    perFrameInv: true,
    entries: [entry(0, 0, 10, 1)],
  });
  const segs = simulateGpoWindow(gpo, timing, true, 1);
  assert.equal(levelAt(segs, 0), 1); // inverted: was low -> high
  assert.equal(levelAt(segs, 20), 0); // was high -> low
});

test('mask: outside gate region outputs Region_other_Value', () => {
  // gate window: vst=0,vend=2 (lines 0..2), pst=0,pend=linePcnt (full line width)
  const gpo = baseGpo({
    repeatMode: 0,
    maskEnabled: true,
    regionVst: 0, regionVend: 2, regionPst: 0, regionPend: linePcnt,
    regionOtherValue: 0,
    entries: [entry(0, 0, 0, 1)], // high everywhere by carry
  });
  const segs = simulateGpoWindow(gpo, timing, false, 1);
  // inside gate (line 0): high; outside gate (line 5): Region_other_Value=0
  assert.equal(levelAt(segs, 5), 1);
  assert.equal(levelAt(segs, 5 * linePcnt + 5), 0);
});

test('combin type 0 (pass): out equals own raw', () => {
  const gpo = baseGpo({ combinType: 0, combinSel: 2, entries: [entry(0, 0, 10, 1)] });
  const other = baseGpo({ index: 2, entries: [entry(0, 0, 20, 1)] });
  const out = simulateGpoOutWindow(gpo, [gpo, other], timing, true, 1);
  assert.equal(levelAt(out, 5), 0);
  assert.equal(levelAt(out, 20), 1);
});

test('combin type 1 (AND): high only where both own and other are high', () => {
  const gpo = baseGpo({ combinType: 1, combinSel: 2, entries: [entry(0, 0, 10, 1)] }); // high [10,linePcnt)
  const other = baseGpo({ index: 2, entries: [entry(0, 0, 30, 1)] }); // high [30,linePcnt)
  const out = simulateGpoOutWindow(gpo, [gpo, other], timing, true, 1);
  assert.equal(levelAt(out, 20), 0); // own high, other low -> 0
  assert.equal(levelAt(out, 40), 1); // both high -> 1
});

test('combin type 2 (OR): high where either is high', () => {
  const gpo = baseGpo({ combinType: 2, combinSel: 2, entries: [entry(0, 0, 10, 1)] });
  const other = baseGpo({ index: 2, entries: [entry(0, 0, 30, 1)] });
  const out = simulateGpoOutWindow(gpo, [gpo, other], timing, true, 1);
  assert.equal(levelAt(out, 20), 1); // own high -> 1
  assert.equal(levelAt(out, 40), 1);
});

test('combin type 3 (XOR): high where levels differ', () => {
  const gpo = baseGpo({ combinType: 3, combinSel: 2, entries: [entry(0, 0, 10, 1)] });
  const other = baseGpo({ index: 2, entries: [entry(0, 0, 30, 1)] });
  const out = simulateGpoOutWindow(gpo, [gpo, other], timing, true, 1);
  assert.equal(levelAt(out, 20), 1); // own high, other low -> differ -> 1
  assert.equal(levelAt(out, 40), 0); // both high -> same -> 0
});

test('combin type 4 (NOT): inverts own', () => {
  const gpo = baseGpo({ combinType: 4, combinSel: 2, entries: [entry(0, 0, 10, 1)] });
  const out = simulateGpoOutWindow(gpo, [gpo], timing, true, 1);
  assert.equal(levelAt(out, 5), 1); // own low -> not -> high
  assert.equal(levelAt(out, 20), 0); // own high -> not -> low
});

test('combin type 5 (HI) / 6 (LOW): constant levels', () => {
  const hi = baseGpo({ combinType: 5, entries: [entry(0, 0, 10, 1)] });
  const hiOut = simulateGpoOutWindow(hi, [hi], timing, true, 1);
  assert.equal(levelAt(hiOut, 5), 1);
  assert.equal(levelAt(hiOut, 20), 1);
  const lo = baseGpo({ combinType: 6, entries: [entry(0, 0, 10, 1)] });
  const loOut = simulateGpoOutWindow(lo, [lo], timing, true, 1);
  assert.equal(levelAt(loOut, 5), 0);
  assert.equal(levelAt(loOut, 20), 0);
});

test('combin type 7 (other): falls back to own when other empty', () => {
  const gpo = baseGpo({ combinType: 7, combinSel: 99, entries: [entry(0, 0, 10, 1)] });
  const out = simulateGpoOutWindow(gpo, [gpo], timing, true, 1); // no other gpo index 99
  assert.equal(levelAt(out, 20), 1); // falls back to own
});

test('simulateProject: produces raw + merge signals per gpo and detects families', () => {
  const stv = baseGpo({ index: 1, group: 'GPO1_STV', label: 'STV', repeatMode: 1, entries: [entry(0, 0, 0, 1)] });
  const project: DraftProject = {
    timing,
    gpos: [stv],
    levelShifter: { model: 'none' },
    measurements: [],
    patches: [],
    dirty: false,
  };
  const result = simulateProject(project);
  assert.ok(result.signals.length > 0);
  const stvFamily = result.families.find((f) => f.id === 'stv');
  assert.ok(stvFamily, 'STV family auto-detected');
  assert.equal(stvFamily?.rawGpo, 1);
  // gpoSignals has raw + merge for the one gpo
  assert.equal(result.gpoSignals.length, 2);
});

test('simulateProject: TER/CPV2 inference — Repeat_mode_SEL=1 & OCP_SEL!=1 -> TER', () => {
  const cpv2 = baseGpo({ index: 4, group: 'GPO4_CPV2', label: 'CPV2', repeatMode: 1, entries: [entry(0, 0, 0, 1)] });
  const project: DraftProject = {
    timing,
    gpos: [cpv2],
    levelShifter: { ...defaultLevelShifterConfig(), ocpSel: 'float' },
    measurements: [],
    patches: [],
    dirty: false,
  };
  const result = simulateProject(project);
  assert.equal(result.inference.role, 'TER');
  assert.equal(result.inference.severity, 'ok');
});

test('simulateProject: TER/CPV2 inference — Repeat_mode_SEL=1 & OCP_SEL=1 -> ERROR', () => {
  const cpv2 = baseGpo({ index: 4, group: 'GPO4_CPV2', label: 'CPV2', repeatMode: 1, entries: [entry(0, 0, 0, 1)] });
  const project: DraftProject = {
    timing,
    gpos: [cpv2],
    levelShifter: { ...defaultLevelShifterConfig(), ocpSel: '1' },
    measurements: [],
    patches: [],
    dirty: false,
  };
  const result = simulateProject(project);
  assert.equal(result.inference.role, 'ERROR');
  assert.equal(result.inference.severity, 'error');
});

test('simulateProject: validation warns on PCNT exceeding pcntMax', () => {
  const gpo = baseGpo({ repeatMode: 0, entries: [entry(0, 0, timing.pcntMax + 5, 1)] });
  const project: DraftProject = {
    timing,
    gpos: [gpo],
    levelShifter: { model: 'none' },
    measurements: [],
    patches: [],
    dirty: false,
  };
  const result = simulateProject(project);
  assert.ok(result.warnings.some((w) => w.includes('PCNT') && w.includes('超过')));
});
