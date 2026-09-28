import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEntryChanges, draggedEntryPosition, offsetEntryPosition } from '../entryEdits';
import { simulateGpoOutWindow } from '../simulator';
import { entry, gpo, project, timing, levelAt } from '../../testSupport/fixtures';

test('entry edits: reject negative, fractional, non-finite and overflowing PCNT atomically', () => {
  for (const pcnt of [-3, 10.5, NaN, Infinity, timing.pcntMax + 1]) {
    const p = project(), g = p.gpos[0], before = structuredClone(g.entries[0]);
    assert.throws(() => applyEntryChanges(p, g, g.entries[0], { pcnt }));
    assert.deepEqual(g.entries[0], before);
    assert.deepEqual(p.patches, []);
  }
});

test('entry edits: reject fractional FCNT before bitwise decoding', () => {
  const p = project(), g = p.gpos[0];
  assert.throws(() => applyEntryChanges(p, g, g.entries[0], { fcnt: 32768.5 }), /FCNT/);
  assert.equal(p.patches.length, 0);
});

test('entry edits: validate all fields and source cells before changing anything', () => {
  const p = project(), g = p.gpos[0], e = g.entries[0];
  delete e.cells.lcnt;
  assert.throws(() => applyEntryChanges(p, g, e, { lcnt: 1, pcnt: 20 }), /单元格/);
  assert.equal(e.lcnt, 0);
  assert.equal(e.pcnt, 10);
  assert.equal(p.patches.length, 0);
});

test('entry edits: by-line LCNT restriction applies to all edit paths', () => {
  const p = project([gpo({ repeatMode: 0 })]), g = p.gpos[0], e = g.entries[0];
  assert.throws(() => applyEntryChanges(p, g, e, offsetEntryPosition(e, 100, timing)), /by-line/);
  assert.equal(e.lcnt, 0);
});

test('entry edits: dragging in FCNT=1 preserves the frame and pulse', () => {
  const g = gpo({ repeatCount: 1, entries: [entry(0, 0, 10, 1, { frameCount: 1 }), entry(1, 0, 40, 0, { frameCount: 1 })] });
  const p = project([g]);
  const next = draggedEntryPosition(g, g.entries[0], timing, 1020, 0);
  assert.deepEqual(next, { lcnt: 0, pcnt: 20 });
  assert.equal(applyEntryChanges(p, g, g.entries[0], next), true);
  assert.equal(g.entries[0].frameCount, 1);
  const segments = simulateGpoOutWindow(g, [g], timing, false, 2);
  assert.equal(levelAt(segments, 1015), 0);
  assert.equal(levelAt(segments, 1025), 1);
  assert.equal(p.patches.length, 1);
});

test('entry edits: dragging beyond the assigned frame is rejected', () => {
  const g = gpo({ repeatCount: 1, entries: [entry(0, 0, 10, 1, { frameCount: 1 })] });
  const p = project([g]);
  assert.throws(() => applyEntryChanges(p, g, g.entries[0], draggedEntryPosition(g, g.entries[0], timing, 2020, 0)), /LCNT/);
  assert.equal(p.patches.length, 0);
});

test('entry edits: FCNT changes update packed enable, level and frame fields together', () => {
  const p = project([gpo({ repeatCount: 2 })]), g = p.gpos[0], e = g.entries[0];
  applyEntryChanges(p, g, e, { fcnt: 0x8001 });
  assert.equal(e.enabled, true);
  assert.equal(e.level, 0);
  assert.equal(e.frameCount, 1);
  assert.equal(p.patches[0].newValue, 0x8001);
});

test('entry edits: no-op changes do not create patches', () => {
  const p = project(), g = p.gpos[0];
  assert.equal(applyEntryChanges(p, g, g.entries[0], { pcnt: 10 }), false);
  assert.equal(p.patches.length, 0);
});
