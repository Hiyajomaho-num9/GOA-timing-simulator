import { createWaveformEngine, type DrawableSegment, type EdgeQuery, type SignalQuery, type SignalSummary, type WaveformEngine } from './waveformEngine';
import type { DraftProject, Edge } from './types';

export type WaveformWorkerRequest =
  | { id: number; type: 'init'; project: DraftProject }
  | { id: number; type: 'querySignals'; query: SignalQuery }
  | { id: number; type: 'nearestEdge'; query: EdgeQuery }
  | { id: number; type: 'summarizeSignal'; signalId: string; startPcnt: number; endPcnt: number }
  | { id: number; type: 'queryableSignalIds' };

export type WaveformWorkerResponse =
  | { id: number; ok: true; type: 'init'; signalIds: string[] }
  | { id: number; ok: true; type: 'querySignals'; segments: DrawableSegment[] }
  | { id: number; ok: true; type: 'nearestEdge'; edge: Edge | undefined }
  | { id: number; ok: true; type: 'summarizeSignal'; summary: SignalSummary }
  | { id: number; ok: true; type: 'queryableSignalIds'; signalIds: string[] }
  | { id: number; ok: false; error: string };

export function createWaveformWorkerHost(): { handle(request: WaveformWorkerRequest): WaveformWorkerResponse } {
  let engine: WaveformEngine | undefined;

  function requireEngine(): WaveformEngine {
    if (!engine) throw new Error('Waveform engine is not initialized');
    return engine;
  }

  return {
    handle(request: WaveformWorkerRequest): WaveformWorkerResponse {
      try {
        switch (request.type) {
          case 'init':
            engine = createWaveformEngine(request.project);
            return { id: request.id, ok: true, type: 'init', signalIds: engine.queryableSignalIds() };
          case 'querySignals':
            return { id: request.id, ok: true, type: 'querySignals', segments: requireEngine().querySignals(request.query) };
          case 'nearestEdge':
            return { id: request.id, ok: true, type: 'nearestEdge', edge: requireEngine().nearestEdge(request.query) };
          case 'summarizeSignal':
            return { id: request.id, ok: true, type: 'summarizeSignal', summary: requireEngine().summarizeSignal(request.signalId, request.startPcnt, request.endPcnt) };
          case 'queryableSignalIds':
            return { id: request.id, ok: true, type: 'queryableSignalIds', signalIds: requireEngine().queryableSignalIds() };
        }
      } catch (error) {
        return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

type WorkerScope = {
  addEventListener?: (type: 'message', listener: (event: { data: WaveformWorkerRequest }) => void) => void;
  postMessage?: (response: WaveformWorkerResponse) => void;
  document?: unknown;
};

const scope = globalThis as WorkerScope;
if (typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function' && scope.document === undefined) {
  const host = createWaveformWorkerHost();
  scope.addEventListener('message', (event) => {
    scope.postMessage?.(host.handle(event.data));
  });
}
