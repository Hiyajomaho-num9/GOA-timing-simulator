import type { Edge, SignalTrace, TimingBase } from '../core/types';
import { formatPcnt } from '../core/time';

export type WaveformView = {
  start: number;
  end: number;
};

export type WaveformHitMap = {
  plotLeft: number;
  plotWidth: number;
  top: number;
  rowH: number;
  view: WaveformView;
  timing: TimingBase;
  edges: Array<Edge & { x: number; y1: number; y2: number }>;
  rows: Array<{ signal: SignalTrace; y1: number; y2: number; highY: number; lowY: number }>;
};

export type WaveformDrawOptions = {
  hoverEdgeId?: string;
  cursorAt?: number;
  cursorSignalName?: string;
  showPulseCount?: boolean;
  selectedStartEdgeId?: string;
  selectedEndEdgeId?: string;
};

export function drawWaveform(
  canvas: HTMLCanvasElement,
  signals: SignalTrace[],
  timing: TimingBase | undefined,
  view: WaveformView | undefined,
  options: WaveformDrawOptions = {},
): WaveformHitMap | undefined {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#07111f';
  ctx.fillRect(0, 0, width, height);

  if (!timing || !view || signals.length === 0) {
    drawEmpty(ctx, width, height, '导入 XLSX 并点击重新计算波形');
    return undefined;
  }

  const left = options.showPulseCount ? 260 : 190;
  const top = 42;
  const bottomPad = 16;
  const plotH = Math.max(80, height - top - bottomPad);
  const rowH = Math.max(12, plotH / Math.max(1, signals.length));
  const amp = Math.max(4, Math.min(15, rowH * 0.32));
  const labelFont = Math.max(8, Math.min(12, rowH * 0.36));
  const labelYOffset = Math.max(9, Math.min(25, rowH * 0.62));
  const plotW = Math.max(100, width - left - 24);
  const span = Math.max(1, view.end - view.start);
  const xOf = (t: number) => left + ((t - view.start) / span) * plotW;
  const hitEdges: WaveformHitMap['edges'] = [];
  const hitRows: WaveformHitMap['rows'] = [];
  const markers: Array<{ edge: Edge; x: number; y1: number; y2: number; color: string; label: string }> = [];

  drawGrid(ctx, left, top, plotW, signals.length * rowH, view, timing);

  ctx.font = `${labelFont}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  for (let i = 0; i < signals.length; i += 1) {
    const signal = signals[i];
    const y = top + i * rowH;
    const centerY = y + rowH / 2;
    const highY = centerY - amp;
    const lowY = centerY + amp;
    hitRows.push({ signal, y1: y, y2: y + rowH, highY, lowY });
    ctx.fillStyle = '#d7e3f4';
    const label = options.showPulseCount ? `${signal.name} | +${countPositivePulses(signal)}${signal.summary ? ` | ${signal.summary}` : ''}` : signal.name;
    ctx.fillText(label, 14, y + labelYOffset);
    ctx.strokeStyle = '#1d2a3c';
    ctx.beginPath();
    ctx.moveTo(left, lowY);
    ctx.lineTo(left + plotW, lowY);
    ctx.stroke();
    ctx.strokeStyle = signal.color ?? '#7fa6bd';
    ctx.lineWidth = Math.max(1, Math.min(signal.kind === 'ck' ? 2.4 : 2, rowH * 0.11));
    ctx.beginPath();
    let started = false;
    for (const segment of signal.segments) {
      if (segment.end < view.start || segment.start > view.end) continue;
      const sx = xOf(Math.max(segment.start, view.start));
      const ex = xOf(Math.min(segment.end, view.end));
      const yy = segment.level ? highY : lowY;
      if (!started) {
        ctx.moveTo(sx, yy);
        started = true;
      } else {
        ctx.lineTo(sx, yy);
      }
      ctx.lineTo(ex, yy);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = '#c98a91';
    for (const edge of signal.edges) {
      if (edge.at < view.start || edge.at > view.end) continue;
      const x = xOf(edge.at);
      const edgeW = rowH < 18 ? 1 : 2;
      ctx.fillRect(x - edgeW / 2, highY - 2, edgeW, lowY - highY + 4);
      hitEdges.push({ ...edge, x, y1: y, y2: y + rowH });
      if (edge.id === options.hoverEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#9ab6c6', label: 'SNAP' });
      if (edge.id === options.selectedStartEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#9db68b', label: 'START' });
      if (edge.id === options.selectedEndEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#b89b78', label: 'END' });
    }
  }

  drawMarkers(ctx, markers, top, signals.length * rowH, left, plotW);
  if (options.cursorAt !== undefined) drawFreeCursor(ctx, xOf(options.cursorAt), top, signals.length * rowH, left, plotW, options.cursorSignalName);

  ctx.fillStyle = '#9fb2cf';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(`${formatPcnt(view.start, timing.pcntPerLine)} -> ${formatPcnt(view.end, timing.pcntPerLine)}`, left, 18);
  ctx.fillText(`1pcnt ${(timing.pcntSeconds * 1e9).toFixed(3)}ns | 1lcnt ${(timing.lcntSeconds * 1e6).toFixed(3)}us | frame ${(timing.frameSeconds * 1e3).toFixed(3)}ms`, left, 34);
  return { plotLeft: left, plotWidth: plotW, top, rowH, view, timing, edges: hitEdges, rows: hitRows };
}

function countPositivePulses(signal: SignalTrace): number {
  return signal.segments.filter((segment) => segment.level === 1).length;
}

function drawFreeCursor(ctx: CanvasRenderingContext2D, x: number, top: number, plotHeight: number, left: number, plotW: number, label?: string): void {
  if (x < left || x > left + plotW) return;
  ctx.save();
  ctx.strokeStyle = '#b4a078';
  ctx.fillStyle = '#b4a078';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(x, top - 14);
  ctx.lineTo(x, top + plotHeight + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.12;
  ctx.fillRect(Math.max(left, x - 4), top - 10, Math.min(8, left + plotW - x + 4), plotHeight + 14);
  ctx.globalAlpha = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(label ? `POINT ${label}` : 'POINT', Math.min(x + 6, left + plotW - 120), top - 20);
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number, view: WaveformView, timing: TimingBase): void {
  ctx.strokeStyle = '#17243a';
  ctx.lineWidth = 1;
  const span = view.end - view.start;
  const lineStep = timing.pcntPerLine;
  const firstLine = Math.ceil(view.start / lineStep) * lineStep;
  for (let t = firstLine; t <= view.end; t += lineStep) {
    const x = left + ((t - view.start) / span) * width;
    ctx.beginPath();
    ctx.moveTo(x, top - 12);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }
}

function drawMarkers(
  ctx: CanvasRenderingContext2D,
  markers: Array<{ edge: Edge; x: number; y1: number; y2: number; color: string; label: string }>,
  top: number,
  plotHeight: number,
  left: number,
  plotW: number,
): void {
  const seen = new Set<string>();
  for (const marker of markers) {
    const key = `${marker.edge.id}:${marker.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.save();
    ctx.strokeStyle = marker.color;
    ctx.fillStyle = marker.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(marker.x, top - 14);
    ctx.lineTo(marker.x, top + plotHeight + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.16;
    ctx.fillRect(Math.max(left, marker.x - 7), marker.y1, Math.min(14, left + plotW - marker.x + 7), marker.y2 - marker.y1);
    ctx.globalAlpha = 1;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(marker.label, Math.min(marker.x + 5, left + plotW - 46), Math.max(14, marker.y1 - 4));
    ctx.restore();
  }
}

function drawEmpty(ctx: CanvasRenderingContext2D, width: number, height: number, message: string): void {
  ctx.fillStyle = '#9fb2cf';
  ctx.font = '18px Georgia, serif';
  ctx.fillText(message, 32, Math.max(60, height / 2));
}
