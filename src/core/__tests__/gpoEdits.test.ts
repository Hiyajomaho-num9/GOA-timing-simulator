import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGpoChange } from '../gpoEdits';
import { cell, project } from '../../testSupport/fixtures';

test('GPO edits: invalid numbers or missing source cells never mutate state', () => {
  const p = project(), g = p.gpos[0]; g.cells.Repeat_Count_num = cell('K9');
  for (const value of [-1, 0.5, NaN, Infinity]) assert.throws(() => applyGpoChange(p, g, 'repeatCount', value));
  assert.throws(() => applyGpoChange(p, g, 'regionVst', 2), /单元格/);
  assert.equal(g.repeatCount, 0); assert.equal(g.regionVst, 0); assert.equal(p.patches.length, 0);
});

test('GPO edits: preserve original cell names and write booleans as numeric registers', () => {
  const p = project(), g = p.gpos[0]; g.cells.mask_region_en = cell('K10');
  assert.equal(applyGpoChange(p, g, 'maskEnabled', true), true);
  assert.equal(g.maskEnabled, true); assert.equal(p.patches[0].newValue, 1);
  assert.equal(p.patches[0].name, 'mask_region_en');
});
