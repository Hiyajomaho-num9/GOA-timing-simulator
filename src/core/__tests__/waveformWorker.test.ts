import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaveformWorkerHost } from '../waveformWorker';
import { makeTimingBase } from '../time';
import type { DraftProject, GpoConfig, GpoEntry } from '../types';

const timing = makeTimingBase(2170, 1140, 60);

function entry(index: number, lcnt: number, pcnt: number, level: 0 | 1): GpoEntry {
  return { index, fcnt: 0, lcnt, pcnt, enabled: true, level, frameCount: 0, cells: {} };
}

function gpo(over: Partial<GpoConfig> = {}): GpoConfig {
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

test('waveform worker host: requires init', () => {
  const response = createWaveformWorkerHost().handle({ id: 1, type: 'queryableSignalIds' });
  if (response.ok) throw new Error('expected init error');
  assert.match(response.error, /not initialized/);
});

test('waveform worker host: init and querySignals', () => {
  const host = createWaveformWorkerHost();
  const cfg = gpo({ entries: [entry(0, 0, 10, 1), entry(1, 0, 20, 0)] });
  const id = `gpo:${cfg.index}:merge`;

  const init = host.handle({ id: 1, type: 'init', project: project([cfg]) });
  if (!init.ok) throw new Error(init.error);
  assert.equal(init.type, 'init');
  if (init.type !== 'init') throw new Error('unexpected response');
  assert.ok(init.signalIds.includes(id));

  const query = host.handle({ id: 2, type: 'querySignals', query: { signalIds: [id], startPcnt: 0, endPcnt: 30, pixelWidth: 100, mode: 'exact' } });
  if (!query.ok) throw new Error(query.error);
  assert.equal(query.type, 'querySignals');
  if (query.type !== 'querySignals') throw new Error('unexpected response');
  assert.equal(query.segments.some((segment) => segment.level === 1 && segment.start === 10 && segment.end === 20), true);
});

test('waveform worker host: nearestEdge', () => {
  const host = createWaveformWorkerHost();
  const cfg = gpo({ entries: [entry(0, 0, 10, 1)] });
  const id = `gpo:${cfg.index}:merge`;
  host.handle({ id: 1, type: 'init', project: project([cfg]) });

  const response = host.handle({ id: 2, type: 'nearestEdge', query: { signalId: id, at: 12, radiusPcnt: 100 } });
  if (!response.ok) throw new Error(response.error);
  assert.equal(response.type, 'nearestEdge');
  if (response.type !== 'nearestEdge') throw new Error('unexpected response');
  assert.equal(response.edge?.at, 10);
});
