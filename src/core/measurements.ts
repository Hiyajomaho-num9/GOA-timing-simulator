import type { DraftProject, Edge, Measurement, MeasurementResult, TimingBase } from './types';

export function parseTargetSeconds(value: string | undefined, timing: DraftProject['timing']): number | undefined {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return undefined;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|pcnt|lcnt)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? 'us';
  if (unit === 'ns') return amount * 1e-9;
  if (unit === 'us' || unit === 'µs') return amount * 1e-6;
  if (unit === 'ms') return amount * 1e-3;
  if (unit === 's') return amount;
  if (unit === 'pcnt') return timing ? amount * timing.pcntSeconds : undefined;
  if (unit === 'lcnt') return timing ? amount * timing.lcntSeconds : undefined;
  return undefined;
}


export function resolveMeasurement(measurement: Measurement, edges: Edge[], timing: TimingBase): MeasurementResult {
  const targetSeconds = measurement.targetInput !== undefined ? parseTargetSeconds(measurement.targetInput, timing) : measurement.targetSeconds;
  measurement = { ...measurement, targetSeconds };
  const startEdge = resolveMeasurementEdge(measurement.startEdgeId, measurement.startPoint, edges);
  const endEdge = resolveMeasurementEdge(measurement.endEdgeId, measurement.endPoint, edges);
  if (!startEdge || !endEdge) return { ...measurement, startEdge, endEdge };
  const deltaPcnt = endEdge.at - startEdge.at;
  const seconds = deltaPcnt * timing.pcntSeconds;
  if (measurement.targetSeconds === undefined) return { ...measurement, startEdge, endEdge, deltaPcnt, seconds };
  const errorSeconds = seconds - measurement.targetSeconds;
  const errorPcnt = Math.round(errorSeconds / timing.pcntSeconds);
  return {
    ...measurement,
    startEdge,
    endEdge,
    deltaPcnt,
    seconds,
    errorSeconds,
    errorPcnt,
    errorLcnt: Math.trunc(errorPcnt / timing.pcntPerLine),
    errorRemainderPcnt: errorPcnt % timing.pcntPerLine,
  };
}

function resolveMeasurementEdge(edgeId: string, snapshot: Edge | undefined, edges: Edge[]): Edge | undefined {
  const exact = edges.find((edge) => edge.id === edgeId);
  if (exact) return exact;
  if (!snapshot) return undefined;
  const candidates = edges.filter((edge) => (
    edge.signalId === snapshot.signalId
    && edge.edge === snapshot.edge
    && edge.level === snapshot.level
  ));
  if (snapshot.edge === 'point') return snapshot;
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, edge) => (Math.abs(edge.at - snapshot.at) < Math.abs(best.at - snapshot.at) ? edge : best), candidates[0]);
}


/** Reserve monotonically increasing IDs, even after the newest row is deleted. */
export function addMeasurement(project: DraftProject, start: Edge, end: Edge): Measurement {
  const maximum = project.measurements.reduce((max, item) => {
    const match = /^T([0-9]+)$/.exec(item.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const number = Math.max(project.nextMeasurementNumber ?? 1, maximum + 1);
  project.nextMeasurementNumber = number + 1;
  const measurement: Measurement = { id: 'T' + number, startEdgeId: start.id, endEdgeId: end.id,
    startPoint: { ...start }, endPoint: { ...end } };
  project.measurements.push(measurement);
  return measurement;
}

export type MeasurementEndpoint = 'start' | 'end' | 'both' | undefined;

/** Unrelated entries use a manual offset; moving both endpoints cannot correct a duration. */
export function measurementCorrection(measurement: MeasurementResult, endpoint: MeasurementEndpoint): number | undefined {
  if (measurement.errorPcnt === undefined || endpoint === 'both') return undefined;
  return endpoint === 'start' ? measurement.errorPcnt : -measurement.errorPcnt;
}
