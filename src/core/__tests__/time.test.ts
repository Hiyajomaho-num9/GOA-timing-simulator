import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absPcnt, formatCount4, formatDuration, formatPcnt, makeTimingBase } from '../time';

test('makeTimingBase: MT9216 uses PanelHTotal + 1 as htotal', () => {
  const t = makeTimingBase(2170, 1140, 60);
  assert.equal(t.htotal, 2171);
  assert.equal(t.pcntPerLine, 2171);
  assert.equal(t.pcntMax, 2170);
  assert.equal(t.soc, 'mt9216');
});

test('makeTimingBase: MT9216 pcnt/lcnt/frame seconds match README formula', () => {
  const t = makeTimingBase(2170, 1140, 60);
  // 1pcnt = 1/(2171*1140*60)
  const expectedPcnt = 1 / (2171 * 1140 * 60);
  assert.ok(Math.abs(t.pcntSeconds - expectedPcnt) < 1e-18, `pcnt ${t.pcntSeconds} vs ${expectedPcnt}`);
  assert.ok(Math.abs(t.lcntSeconds - expectedPcnt * 2171) < 1e-15);
  assert.ok(Math.abs(t.frameSeconds - 1 / 60) < 1e-12);
});

test('makeTimingBase: MT9603 uses half-line pcnt and direct htotal', () => {
  const t = makeTimingBase(2199, 1126, 60, { soc: 'mt9603', panelMinHtotal: 2199 });
  // MT9603: htotal arg is register-1 from parser, but makeTimingBase adds +1 -> register value again.
  assert.equal(t.htotal, 2200);
  assert.equal(t.pcntPerLine, 1100); // floor(2200/2)
  // pcntMax = min(floor(panelMinHtotal/2 - 1), floor(htotal/2 - 9))
  assert.equal(t.pcntMax, Math.min(Math.floor(2199 / 2 - 1), Math.floor(2200 / 2 - 9)));
  assert.equal(t.soc, 'mt9603');
  const expectedPcnt = 1 / (1100 * 1126 * 60);
  assert.ok(Math.abs(t.pcntSeconds - expectedPcnt) < 1e-18);
});

test('absPcnt: lcnt * htotal + pcnt', () => {
  assert.equal(absPcnt(3, 5, 2171), 3 * 2171 + 5);
  assert.equal(absPcnt(0, 0, 2171), 0);
});

test('formatCount4: zero-pads to 4 with sign', () => {
  assert.equal(formatCount4(0), '0000');
  assert.equal(formatCount4(42), '0042');
  assert.equal(formatCount4(12345), '12345');
  assert.equal(formatCount4(-7), '-0007');
});

test('formatPcnt: splits abs into L/P', () => {
  // lcnt=2, pcnt=13, htotal=2171 -> abs = 2*2171+13 = 4355
  assert.equal(formatPcnt(4355, 2171), 'L0002.P0013');
});

test('formatDuration: picks ns/us/ms bands', () => {
  assert.equal(formatDuration(6.734e-9), '6.73 ns');
  assert.equal(formatDuration(14.620e-6), '14.620 us');
  assert.equal(formatDuration(16.667e-3), '16.667 ms');
  assert.equal(formatDuration(undefined), '-');
  assert.equal(formatDuration(NaN), '-');
});
