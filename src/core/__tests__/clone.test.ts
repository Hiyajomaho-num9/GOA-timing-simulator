import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneModel } from '../clone';
import { project } from '../../testSupport/fixtures';

test('model clone: native and legacy fallback preserve model data without shared references', () => {
  const saved = globalThis.structuredClone;
  try {
    for (const native of [true, false]) {
      Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, value: native ? saved : undefined });
      const p = project(), cloned = cloneModel(p);
      assert.deepEqual(cloned, p);
      cloned.gpos[0].entries[0].pcnt = 50;
      assert.equal(p.gpos[0].entries[0].pcnt, 10);
      assert.equal(cloneModel(undefined), undefined);
    }
  } finally {
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, value: saved });
  }
});
