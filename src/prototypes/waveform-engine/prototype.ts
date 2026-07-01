// Throwaway Phase 1 prototype for the query-based waveform engine.
//
// Run via: npm run prototype:engine  (compiles core + this file to a temp dir
// under CommonJS, then runs it — see scripts/prototype-engine.mjs).
//
// Loads the real MT9216 sample xlsx, builds the query engine, and runs four
// scenarios comparing the new query path against the old full-generation
// path. Prints acceptance numbers honestly — if a target is missed, it says so.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseXlsxBuffer } from '../../core/xlsxParser';
import { simulateGpoOutWindow, simulateProject } from '../../core/simulator';
import { createWaveformEngine } from '../../core/waveformEngine';
import { defaultLevelShifterConfig, type DraftProject, type GpoConfig } from '../../core/types';

// The runner (scripts/prototype-engine.mjs) sets GOA_SAMPLE_XLSX to the repo's
// sample workbook absolute path, so this file does not need import.meta (which
// is unavailable when compiled to CommonJS).
const sampleXlsx = process.env.GOA_SAMPLE_XLSX
  ?? path.join(process.cwd(), 'EPL_MT9216_Cus_V430HJ2-P01(B1)_250819.xlsx');

function ms(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function countEdges(segments: { start: number; level: 0 | 1 }[]): number {
  let count = 0;
  let prev: 0 | 1 = 0;
  for (const s of segments) {
    if (s.start > 0 && s.level !== prev) count += 1;
    prev = s.level;
  }
  return count;
}

function findGpo(gpos: GpoConfig[], re: RegExp): GpoConfig | undefined {
  return gpos.find((g) => re.test(`${g.group} ${g.label}`));
}

function main(): void {
  const fileBuffer = readFileSync(sampleXlsx);
  // readFileSync returns a Node Buffer; parseXlsxBuffer wants an ArrayBuffer.
  const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer;
  const parsed = parseXlsxBuffer(arrayBuffer, path.basename(sampleXlsx), 60);
  const timing = parsed.timing;
  const gpos = parsed.gpos;
  const frameTotal = timing.pcntPerLine * timing.vtotal;

  const project: DraftProject = {
    parsed,
    timing,
    gpos,
    levelShifter: defaultLevelShifterConfig(),
    measurements: [],
    patches: [],
    dirty: false,
  };

  console.log(`sample: ${path.basename(sampleXlsx)}`);
  console.log(`timebase: Htotal=${timing.htotal} Vtotal=${timing.vtotal} FPS=60  frameTotal=${frameTotal}pcnt`);
  console.log('');

  // Build the engine once. simulateProject runs inside createWaveformEngine.
  const engineBuildMs = ms(() => { void createWaveformEngine(project); });
  const engine = createWaveformEngine(project);
  const queryable = engine.queryableSignalIds();
  console.log(`engine build (incl. 1-frame simulateProject): ${engineBuildMs.toFixed(2)}ms`);
  console.log(`queryable signalIds: ${queryable.length}`);
  console.log('');

  const stv = findGpo(gpos, /\bstv\b/i);
  const cpv1 = findGpo(gpos, /\bcpv\s*1\b/i) ?? findGpo(gpos, /\bcpv1\b/i);
  const cpv2 = findGpo(gpos, /\bcpv\s*2\b/i) ?? findGpo(gpos, /\bcpv2\b/i);
  const tp = findGpo(gpos, /\btp\b/i) ?? findGpo(gpos, /driver/i);
  const pol = findGpo(gpos, /\bpol\b/i);
  const stvId = stv ? `gpo:${stv.index}:merge` : undefined;
  const polId = pol ? `gpo:${pol.index}:merge` : undefined;
  const tpId = tp ? `gpo:${tp.index}:merge` : undefined;

  // ---- Scenario A: 1-frame exact query over a typical viewport ----
  console.log('=== Scenario A: 1-frame exact query (viewport = 1 frame, 1600px) ===');
  const aIds = [stvId, cpv1 && `gpo:${cpv1.index}:merge`, cpv2 && `gpo:${cpv2.index}:merge`, tpId].filter(Boolean) as string[];
  const aQueryMs = ms(() => {
    const r = engine.querySignals({ signalIds: aIds, startPcnt: 0, endPcnt: frameTotal, pixelWidth: 1600, mode: 'exact' });
    void r.length;
  });
  const aResult = engine.querySignals({ signalIds: aIds, startPcnt: 0, endPcnt: frameTotal, pixelWidth: 1600, mode: 'exact' });
  // old: 1-frame simulateProject
  const old1Ms = ms(() => { void simulateProject(project); });
  const old1 = simulateProject(project);
  const old1Segs = old1.signals.reduce((s, x) => s + x.segments.length, 0);
  const old1Edges = old1.signals.reduce((s, x) => s + x.edges.length, 0);
  console.log(`  query (exact):  ${aQueryMs.toFixed(2)}ms  segments=${aResult.length}`);
  console.log(`  old 1-frame:    ${old1Ms.toFixed(2)}ms  segments=${old1Segs} edges=${old1Edges} (all signals)`);
  console.log('');

  // ---- Scenario B: 120-frame overview query (the core acceptance test) ----
  console.log('=== Scenario B: 120-frame overview query (full 120 frames, 1600px) ===');
  const ckIds = queryable.filter((id) => /^ck\d+$/.test(id)).slice(0, 8);
  const bIds = [stvId, polId, tpId, ...ckIds].filter(Boolean) as string[];
  const bQueryMs = ms(() => {
    const r = engine.querySignals({ signalIds: bIds, startPcnt: 0, endPcnt: frameTotal * 120, pixelWidth: 1600, mode: 'overview' });
    void r.length;
  });
  const bResult = engine.querySignals({ signalIds: bIds, startPcnt: 0, endPcnt: frameTotal * 120, pixelWidth: 1600, mode: 'overview' });
  // old: 120-frame full generation for the GPO-backed ones in bIds
  const old120Ms = ms(() => {
    for (const id of bIds) {
      const m = id.match(/^gpo:(\d+):merge$/);
      if (!m) continue;
      const gpo = gpos.find((g) => g.index === Number(m[1]));
      if (gpo) void simulateGpoOutWindow(gpo, gpos, timing, false, 120).length;
    }
  });
  let old120Segs = 0;
  let old120Edges = 0;
  for (const id of bIds) {
    const m = id.match(/^gpo:(\d+):merge$/);
    if (!m) continue;
    const gpo = gpos.find((g) => g.index === Number(m[1]));
    if (!gpo) continue;
    const segs = simulateGpoOutWindow(gpo, gpos, timing, false, 120);
    old120Segs += segs.length;
    old120Edges += countEdges(segs);
  }
  console.log(`  query (overview): ${bQueryMs.toFixed(2)}ms  segments=${bResult.length}  signals=${bIds.length}`);
  console.log(`  old 120-frame:    ${old120Ms.toFixed(2)}ms  segments=${old120Segs} edges=${old120Edges} (GPO-backed subset)`);
  console.log(`  segment reduction: ${old120Segs} -> ${bResult.length}  (${(bResult.length / Math.max(1, old120Segs) * 100).toFixed(2)}%)`);
  console.log('');

  // ---- Scenario C: nearestEdge at sample positions ----
  console.log('=== Scenario C: nearestEdge (radius=2000pcnt, 5 sample positions) ===');
  const cId = cpv1 ? `gpo:${cpv1.index}:merge` : stvId!;
  const sampleAts = [frameTotal * 0.25, frameTotal * 0.5, frameTotal * 0.75, frameTotal * 1.5, frameTotal * 2.3];
  let cMaxMs = 0;
  for (const at of sampleAts) {
    const t = ms(() => { void engine.nearestEdge({ signalId: cId, at, radiusPcnt: 2000 }); });
    cMaxMs = Math.max(cMaxMs, t);
    const edge = engine.nearestEdge({ signalId: cId, at, radiusPcnt: 2000 });
    console.log(`  at=${at.toFixed(0)}pcnt  ${t.toFixed(2)}ms  hit=${edge ? `${edge.edge}@${edge.at}` : 'none'}`);
  }
  console.log(`  worst-case nearestEdge: ${cMaxMs.toFixed(2)}ms`);
  console.log('');

  // ---- Scenario D: summarizeSignal (by-line + by-frame) ----
  console.log('=== Scenario D: summarizeSignal ===');
  const byLineGpo = gpos.find((g) => g.repeatMode === 0);
  const byFrameGpo = gpos.find((g) => g.repeatMode === 1);
  if (byLineGpo) {
    const id = `gpo:${byLineGpo.index}:merge`;
    const t = ms(() => { void engine.summarizeSignal(id, 0, frameTotal); });
    const s = engine.summarizeSignal(id, 0, frameTotal);
    console.log(`  by-line  ${id}: ${t.toFixed(2)}ms  pulseCount=${s.pulseCount} W=${s.firstWidthSeconds?.toExponential(3)}s T=${s.periodSeconds?.toExponential(3)}s`);
  }
  if (byFrameGpo) {
    const id = `gpo:${byFrameGpo.index}:merge`;
    const t = ms(() => { void engine.summarizeSignal(id, 0, frameTotal); });
    const s = engine.summarizeSignal(id, 0, frameTotal);
    console.log(`  by-frame ${id}: ${t.toFixed(2)}ms  pulseCount=${s.pulseCount} W=${s.firstWidthSeconds?.toExponential(3)}s T=${s.periodSeconds?.toExponential(3)}s (window-agnostic)`);
  }
  console.log('');

  // ---- Acceptance summary ----
  console.log('=== Acceptance (plan §验收, prototype-testable) ===');
  const bPass = bQueryMs < 100;
  const cPass = cMaxMs < 5;
  console.log(`  [${bPass ? 'PASS' : 'FAIL'}] 120-frame overview first query < 100ms:  ${bQueryMs.toFixed(2)}ms`);
  console.log(`  [${cPass ? 'PASS' : 'FAIL'}] nearestEdge < 5ms:                    ${cMaxMs.toFixed(2)}ms`);
  console.log(`  [INFO] overview segments vs old full edges: ${bResult.length} vs ${old120Edges}`);
  console.log('');
  console.log('Note: CK/LS use the 1-frame preview repeated per frame for long windows.');
  console.log('Note: GPO windows use period-anchor skip; long-repeat edge cases fall back to from-0 generation.');
  if (!bPass) {
    console.log('');
    console.log('!! 120-frame overview did NOT meet <100ms. Per plan, next step is to either');
    console.log('!! optimize generation (period-anchor skip) or move to Phase 2 (Web Worker).');
  }
}

main();
