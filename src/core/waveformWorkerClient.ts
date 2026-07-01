import type { DraftProject, Edge } from './types';
import type { DrawableSegment, EdgeQuery, SignalQuery, SignalSummary } from './waveformEngine';
import type { WaveformWorkerRequest, WaveformWorkerResponse } from './waveformWorker';

type RequestBody<T> = T extends { id: number } ? Omit<T, 'id'> : never;
type WorkerRequestBody = RequestBody<WaveformWorkerRequest>;
type OkResponse = Extract<WaveformWorkerResponse, { ok: true }>;

type Pending = {
  resolve: (response: OkResponse) => void;
  reject: (error: Error) => void;
};

export class WaveformWorkerClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly worker: Worker) {
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  init(project: DraftProject): Promise<string[]> {
    return this.send({ type: 'init', project }).then((response) => {
      if (response.type !== 'init') throw new Error('Unexpected waveform worker response');
      return response.signalIds;
    });
  }

  querySignals(query: SignalQuery): Promise<DrawableSegment[]> {
    return this.send({ type: 'querySignals', query }).then((response) => {
      if (response.type !== 'querySignals') throw new Error('Unexpected waveform worker response');
      return response.segments;
    });
  }

  nearestEdge(query: EdgeQuery): Promise<Edge | undefined> {
    return this.send({ type: 'nearestEdge', query }).then((response) => {
      if (response.type !== 'nearestEdge') throw new Error('Unexpected waveform worker response');
      return response.edge;
    });
  }

  summarizeSignal(signalId: string, startPcnt: number, endPcnt: number): Promise<SignalSummary> {
    return this.send({ type: 'summarizeSignal', signalId, startPcnt, endPcnt }).then((response) => {
      if (response.type !== 'summarizeSignal') throw new Error('Unexpected waveform worker response');
      return response.summary;
    });
  }

  queryableSignalIds(): Promise<string[]> {
    return this.send({ type: 'queryableSignalIds' }).then((response) => {
      if (response.type !== 'queryableSignalIds') throw new Error('Unexpected waveform worker response');
      return response.signalIds;
    });
  }

  dispose(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();
    this.rejectAll(new Error('Waveform worker disposed'));
  }

  private send(body: WorkerRequestBody): Promise<OkResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const request = { ...body, id } as WaveformWorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  private onMessage = (event: MessageEvent<WaveformWorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error));
  };

  private onError = (event: ErrorEvent): void => {
    this.rejectAll(new Error(event.message || 'Waveform worker error'));
  };

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createWaveformWorkerClient(): WaveformWorkerClient {
  return new WaveformWorkerClient(new Worker(new URL('./waveformWorker.ts', import.meta.url), { type: 'module' }));
}
