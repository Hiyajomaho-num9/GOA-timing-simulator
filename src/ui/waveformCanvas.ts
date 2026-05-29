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
  dragPreviewAt?: number;
  dragPreviewLabel?: string;
  showPulseCount?: boolean;
  selectedStartEdgeId?: string;
  selectedEndEdgeId?: string;
};
type WaveformLayout = {
  left: number;
  top: number;
  plotW: number;
  plotH: number;
  rowH: number;
  amp: number;
  labelFont: number;
  labelYOffset: number;
  span: number;
  xOf: (t: number) => number;
};
type WaveformMarker = { edge: Edge; x: number; y1: number; y2: number; color: string; label: string };

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

  const layout = waveformLayout(width, height, signals.length, view, Boolean(options.showPulseCount));
  const hitEdges: WaveformHitMap['edges'] = [];
  const hitRows: WaveformHitMap['rows'] = [];
  const markers: WaveformMarker[] = [];

  drawGrid(ctx, layout.left, layout.top, layout.plotW, signals.length * layout.rowH, view, timing);

  for (let i = 0; i < signals.length; i += 1) {
    drawSignalRow(ctx, signals[i], i, layout, view, options, hitRows, hitEdges, markers);
  }

  drawMarkers(ctx, markers, layout.top, signals.length * layout.rowH, layout.left, layout.plotW);
  if (options.cursorAt !== undefined) drawFreeCursor(ctx, layout.xOf(options.cursorAt), layout.top, signals.length * layout.rowH, layout.left, layout.plotW, options.cursorSignalName);
  if (options.dragPreviewAt !== undefined) drawDragPreview(ctx, layout.xOf(options.dragPreviewAt), layout.top, signals.length * layout.rowH, layout.left, layout.plotW, options.dragPreviewLabel);
  drawHeader(ctx, layout, view, timing);
  return { plotLeft: layout.left, plotWidth: layout.plotW, top: layout.top, rowH: layout.rowH, view, timing, edges: hitEdges, rows: hitRows };
}

function waveformLayout(width: number, height: number, signalCount: number, view: WaveformView, showPulseCount: boolean): WaveformLayout {
  const left = showPulseCount ? 260 : 190;
  const top = 42;
  const plotH = Math.max(80, height - top - 16);
  const rowH = Math.max(12, plotH / Math.max(1, signalCount));
  const plotW = Math.max(100, width - left - 24);
  const span = Math.max(1, view.end - view.start);
  return {
    left,
    top,
    plotW,
    plotH,
    rowH,
    amp: Math.max(4, Math.min(15, rowH * 0.32)),
    labelFont: Math.max(8, Math.min(12, rowH * 0.36)),
    labelYOffset: Math.max(9, Math.min(25, rowH * 0.62)),
    span,
    xOf: (t) => left + ((t - view.start) / span) * plotW,
  };
}

function drawSignalRow(
  ctx: CanvasRenderingContext2D,
  signal: SignalTrace,
  index: number,
  layout: WaveformLayout,
  view: WaveformView,
  options: WaveformDrawOptions,
  hitRows: WaveformHitMap['rows'],
  hitEdges: WaveformHitMap['edges'],
  markers: WaveformMarker[],
): void {
  const y = layout.top + index * layout.rowH;
  const centerY = y + layout.rowH / 2;
  const highY = centerY - layout.amp;
  const lowY = centerY + layout.amp;
  hitRows.push({ signal, y1: y, y2: y + layout.rowH, highY, lowY });
  drawSignalLabel(ctx, signal, y, layout, Boolean(options.showPulseCount));
  drawSignalBaseline(ctx, layout, lowY);
  drawSignalSegments(ctx, signal, view, layout, highY, lowY);
  drawSignalEdges(ctx, signal, view, layout, { y, highY, lowY }, options, hitEdges, markers);
}

function drawSignalLabel(ctx: CanvasRenderingContext2D, signal: SignalTrace, y: number, layout: WaveformLayout, showPulseCount: boolean): void {
  ctx.font = `${layout.labelFont}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.fillStyle = '#d7e3f4';
  const label = showPulseCount ? `${signal.name} | +${countPositivePulses(signal)}${signal.summary ? ` | ${signal.summary}` : ''}` : signal.name;
  ctx.fillText(label, 14, y + layout.labelYOffset);
}

function drawSignalBaseline(ctx: CanvasRenderingContext2D, layout: WaveformLayout, lowY: number): void {
  ctx.strokeStyle = '#1d2a3c';
  ctx.beginPath();
  ctx.moveTo(layout.left, lowY);
  ctx.lineTo(layout.left + layout.plotW, lowY);
  ctx.stroke();
}

function drawSignalSegments(ctx: CanvasRenderingContext2D, signal: SignalTrace, view: WaveformView, layout: WaveformLayout, highY: number, lowY: number): void {
  ctx.strokeStyle = signal.color ?? '#7fa6bd';
  ctx.lineWidth = Math.max(1, Math.min(signal.kind === 'ck' ? 2.4 : 2, layout.rowH * 0.11));
  ctx.beginPath();
  let started = false;
  for (const segment of signal.segments) {
    if (segment.end < view.start || segment.start > view.end) continue;
    const sx = layout.xOf(Math.max(segment.start, view.start));
    const ex = layout.xOf(Math.min(segment.end, view.end));
    const yy = segment.level ? highY : lowY;
    if (started) ctx.lineTo(sx, yy);
    else {
      ctx.moveTo(sx, yy);
      started = true;
    }
    ctx.lineTo(ex, yy);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawSignalEdges(
  ctx: CanvasRenderingContext2D,
  signal: SignalTrace,
  view: WaveformView,
  layout: WaveformLayout,
  row: { y: number; highY: number; lowY: number },
  options: WaveformDrawOptions,
  hitEdges: WaveformHitMap['edges'],
  markers: WaveformMarker[],
): void {
  ctx.fillStyle = '#c98a91';
  for (const edge of signal.edges) {
    if (edge.at < view.start || edge.at > view.end) continue;
    const x = layout.xOf(edge.at);
    const edgeW = layout.rowH < 18 ? 1 : 2;
    ctx.fillRect(x - edgeW / 2, row.highY - 2, edgeW, row.lowY - row.highY + 4);
    hitEdges.push({ ...edge, x, y1: row.y, y2: row.y + layout.rowH });
    appendSelectedMarkers(edge, x, row.highY, row.lowY, options, markers);
  }
}

function appendSelectedMarkers(edge: Edge, x: number, highY: number, lowY: number, options: WaveformDrawOptions, markers: WaveformMarker[]): void {
  if (edge.id === options.hoverEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#9ab6c6', label: 'SNAP' });
  if (edge.id === options.selectedStartEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#9db68b', label: 'START' });
  if (edge.id === options.selectedEndEdgeId) markers.push({ edge, x, y1: highY - 8, y2: lowY + 8, color: '#b89b78', label: 'END' });
}

function drawHeader(ctx: CanvasRenderingContext2D, layout: WaveformLayout, view: WaveformView, timing: TimingBase): void {
  ctx.fillStyle = '#9fb2cf';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(`${formatPcnt(view.start, timing.pcntPerLine)} -> ${formatPcnt(view.end, timing.pcntPerLine)}`, layout.left, 18);
  ctx.fillText(`1pcnt ${(timing.pcntSeconds * 1e9).toFixed(3)}ns | 1lcnt ${(timing.lcntSeconds * 1e6).toFixed(3)}us | frame ${(timing.frameSeconds * 1e3).toFixed(3)}ms`, layout.left, 34);
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

function drawDragPreview(ctx: CanvasRenderingContext2D, x: number, top: number, plotHeight: number, left: number, plotW: number, label?: string): void {
  if (x < left || x > left + plotW) return;
  ctx.save();
  ctx.strokeStyle = '#d4a06b';
  ctx.fillStyle = '#d4a06b';
  ctx.lineWidth = 1.8;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(x, top - 18);
  ctx.lineTo(x, top + plotHeight + 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.18;
  ctx.fillRect(Math.max(left, x - 6), top - 12, Math.min(12, left + plotW - x + 6), plotHeight + 18);
  ctx.globalAlpha = 1;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(label ? `PATCH ${label}` : 'PATCH PREVIEW', Math.min(x + 7, left + plotW - 210), top - 24);
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
