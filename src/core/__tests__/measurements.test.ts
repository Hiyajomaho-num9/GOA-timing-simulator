import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMeasurement, measurementCorrection, parseTargetSeconds } from '../measurements';
import { simulateProject } from '../simulator';
import { makeTimingBase } from '../time';
import { applyEntryChanges, offsetEntryPosition } from '../entryEdits';
import { project, timing } from '../../testSupport/fixtures';

function measured(offset = 0) {
  const p = project();
  p.gpos[0].entries.forEach(entry => { entry.pcnt += offset; });
  const [start, end] = simulateProject(p).gpoSignals.find(s => s.id === 'gpo:1:merge')!.edges;
  const m = addMeasurement(p, start, end);
  return { p, m, start, end };
}

test('measurement IDs stay unique after deleting middle or newest rows', () => {
  const { p, start, end } = measured();
  addMeasurement(p, start, end);
  p.measurements.splice(0, 1);
  assert.equal(addMeasurement(p, start, end).id, 'T3');
  p.measurements.pop();
  assert.equal(addMeasurement(p, start, end).id, 'T4');
  assert.equal(new Set(p.measurements.map(m => m.id)).size, p.measurements.length);
});

test('measurements: removed real edges invalidate the result instead of retaining a snapshot', () => {
  const { p } = measured();
  p.gpos[0].entries[1].enabled = false;
  const m = simulateProject(p).measurements[0];
  assert.equal(m.endEdge, undefined);
  assert.equal(m.deltaPcnt, undefined);
  assert.equal(m.errorPcnt, undefined);
});

test('measurements: manual points remain valid without generated edges', () => {
  const { p, m, start } = measured();
  m.startPoint = { ...start, id: 'manual:test', edge: 'point', at: 5 };
  m.startEdgeId = 'manual:test';
  assert.equal(simulateProject(p).measurements[0].deltaPcnt, 35);
});

test('measurements: count targets track new timing while second targets stay fixed', () => {
  for (const targetInput of ['30pcnt', '0.3lcnt', '300us']) {
    const { p, m } = measured();
    m.targetInput = targetInput;
    m.targetSeconds = parseTargetSeconds(targetInput, timing);
    p.timing = makeTimingBase(99, 10, 200);
    const result = simulateProject(p).measurements[0];
    assert.ok(Math.abs(result.targetSeconds! - (targetInput === '300us' ? 0.0003 : 0.00015)) < 1e-12);
    assert.equal(result.errorPcnt, targetInput === '300us' ? -30 : 0);
  }
});

test('measurements: invalid target text never falls back to a stale converted target', () => {
  const { p, m } = measured();
  m.targetSeconds = 0.001;
  m.targetInput = 'invalid';
  assert.equal(simulateProject(p).measurements[0].errorPcnt, undefined);
});

test('measurements: either endpoint correction reaches the same requested duration', () => {
  for (const role of ['start', 'end'] as const) {
    const { p, m } = measured(10);
    m.targetInput = '40pcnt';
    const result = simulateProject(p).measurements[0];
    const delta = measurementCorrection(result, role)!;
    const g = p.gpos[0], e = g.entries[role === 'start' ? 0 : 1];
    applyEntryChanges(p, g, e, offsetEntryPosition(e, delta, timing));
    assert.equal(simulateProject(p).measurements[0].deltaPcnt, 40);
  }
});

test('measurements: moving both endpoints is not offered as a duration correction', () => {
  const { p, m } = measured(); m.targetInput = '40pcnt';
  assert.equal(measurementCorrection(simulateProject(p).measurements[0], 'both'), undefined);
});
