import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaveformWorkerClient } from '../waveformWorkerClient';
import type { WaveformWorkerRequest, WaveformWorkerResponse } from '../waveformWorker';
import { project } from '../../testSupport/fixtures';

class FakeWorker {
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: WaveformWorkerRequest[] = [];
  terminated = 0;
  failSend = false;
  addEventListener(type: string, handler: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(handler); this.listeners.set(type, set); }
  removeEventListener(type: string, handler: (event: any) => void) { this.listeners.get(type)?.delete(handler); }
  postMessage(message: WaveformWorkerRequest) { if (this.failSend) throw new Error('clone failed'); this.sent.push(message); }
  terminate() { this.terminated++; }
  reply(data: WaveformWorkerResponse) { for (const handler of this.listeners.get('message') ?? []) handler({ data }); }
  error(message: string) { for (const handler of this.listeners.get('error') ?? []) handler({ message }); }
}
function setup() { const worker = new FakeWorker(); return { worker, client: new WaveformWorkerClient(worker as unknown as Worker) }; }

test('worker client: out-of-order responses resolve the matching request', async () => {
  const { worker, client } = setup();
  const one = client.init(project()); const two = client.nearestEdge({ signalId: 'x', at: 1, radiusPcnt: 2 });
  worker.reply({ id: worker.sent[1].id, ok: true, type: 'nearestEdge', edge: undefined });
  worker.reply({ id: worker.sent[0].id, ok: true, type: 'init', signalIds: ['x'] });
  assert.deepEqual(await one, ['x']); assert.equal(await two, undefined); client.dispose();
});

test('worker client: dispose rejects pending and future requests and terminates once', async () => {
  const { worker, client } = setup(); const pending = client.init(project());
  client.dispose(); client.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(client.init(project()), /disposed/);
  assert.equal(worker.terminated, 1);
});

test('worker client: fatal worker errors close the client instead of hanging later calls', async () => {
  const { worker, client } = setup(); const pending = client.init(project());
  worker.error('worker crashed');
  await assert.rejects(pending, /worker crashed/);
  await assert.rejects(client.init(project()), /worker crashed/);
  assert.equal(worker.terminated, 1);
});

test('worker client: synchronous send failure rejects that request and allows recovery', async () => {
  const { worker, client } = setup(); worker.failSend = true;
  await assert.rejects(client.init(project()), /clone failed/);
  worker.failSend = false;
  const next = client.init(project());
  worker.reply({ id: worker.sent[0].id, ok: true, type: 'init', signalIds: [] });
  assert.deepEqual(await next, []); client.dispose();
});
