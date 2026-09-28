import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaveformEngine } from '../waveformEngine';
import { simulateGpoOutWindow } from '../simulator';
import { makeTimingBase } from '../time';
import { gpo, entry, project, timing, levelAt } from '../../testSupport/fixtures';

test('window queries: three-line periods must not be reset at ten-line frame boundaries', () => {
  const g = gpo({ repeatMode: 0, repeatCount: 2, entries: [entry(0, 0, 10, 0), entry(1, 1, 20, 1)] });
  const p = project([g]);
  const actual = createWaveformEngine(p).querySignals({ signalIds: ['stv:merge'], startPcnt: 1400, endPcnt: 1450, pixelWidth: 500, mode: 'exact' });
  const reference = simulateGpoOutWindow(g, [g], timing, false, 2);
  for (let at = 1400; at < 1450; at++) assert.equal(levelAt(actual, at), levelAt(reference, at), 'PCNT ' + at);
});

test('window queries match continuous simulation across periods, masks, inversion and combin inputs', () => {
  for (const lines of [7, 10]) for (const period of [2, 3, 4]) for (const mask of [false, true]) for (const combinType of [0, 3] as const) {
    const t = makeTimingBase(99, lines, 100), frame = t.pcntPerLine * t.vtotal;
    const own = gpo({ repeatMode: 0, repeatCount: period - 1, maskEnabled: mask, regionVst: 1, regionVend: lines - 1,
      perFrameInv: period === 4, combinType, combinSel: 2,
      entries: [entry(0, 0, 10, 0), entry(1, 1, 20, 1)] });
    const other = gpo({ index: 2, group: 'GPO2_POL', repeatMode: 1, repeatCount: 1,
      entries: [entry(0, 0, 15, 1, { frameCount: 1 }), entry(1, 2, 25, 0, { frameCount: 1 })] });
    const p = { ...project([own, other]), timing: t }, engine = createWaveformEngine(p);
    const reference = simulateGpoOutWindow(own, p.gpos, t, false, 5);
    for (let n = 1; n < 5; n++) {
      const start = n * frame + 301, end = (n + 1) * frame - 7;
      const actual = engine.querySignals({ signalIds: ['gpo:1:merge'], startPcnt: start, endPcnt: end, pixelWidth: 1000, mode: 'exact' });
      for (let at = start; at < end; at += 7) assert.equal(levelAt(actual, at), levelAt(reference, at), JSON.stringify({ lines, period, mask, combinType, at }));
    }
  }
});
