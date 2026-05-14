import type { SocProfile, TimingBase } from './types';

export type TimingOptions = {
  soc?: SocProfile;
  panelMinHtotal?: number;
  panelMinVtotal?: number;
  panelDclk?: number;
};

export function makeTimingBase(htotalRegister: number, vtotal: number, frameRate: number, options: TimingOptions = {}): TimingBase {
  const soc = options.soc ?? 'mt9216';
  const htotal = htotalRegister + 1;
  const pcntPerLine = soc === 'mt9603' ? Math.floor(htotal / 2) : htotal;
  const panelMinHtotal = options.panelMinHtotal;
  const pcntMaxByPanel = soc === 'mt9603'
    ? Math.min(
      Math.floor(((panelMinHtotal ?? htotal) / 2) - 1),
      Math.floor(htotal / 2 - 8 - 1),
    )
    : pcntPerLine - 1;
  const pcntMax = Math.max(0, Number.isFinite(pcntMaxByPanel) ? pcntMaxByPanel : pcntPerLine - 1);
  const pcntSeconds = soc === 'mt9603'
    ? 1 / (pcntPerLine * vtotal * frameRate)
    : 1 / (htotal * vtotal * frameRate);
  return {
    soc,
    htotalRegister,
    panelHtotal: htotal,
    panelMinHtotal,
    panelMinVtotal: options.panelMinVtotal,
    panelDclk: options.panelDclk,
    pcntPerLine,
    pcntMax,
    htotal,
    vtotal,
    frameRate,
    pcntSeconds,
    lcntSeconds: pcntPerLine * pcntSeconds,
    frameSeconds: 1 / frameRate,
    pcntFormula: soc === 'mt9603'
      ? '1/(frameRate*vtotal*htotal/2)'
      : '1/(frameRate*vtotal*htotal)',
  };
}

export function absPcnt(lcnt: number, pcnt: number, htotal: number): number {
  return lcnt * htotal + pcnt;
}

export function splitAbs(abs: number, htotal: number): { lcnt: number; pcnt: number } {
  return { lcnt: Math.floor(abs / htotal), pcnt: abs % htotal };
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '-';
  const abs = Math.abs(seconds);
  if (abs < 1e-6) return `${(seconds * 1e9).toFixed(2)} ns`;
  if (abs < 1e-3) return `${(seconds * 1e6).toFixed(3)} us`;
  return `${(seconds * 1e3).toFixed(3)} ms`;
}

export function formatPcnt(abs: number, htotal: number): string {
  const p = splitAbs(abs, htotal);
  return `L${p.lcnt}.P${p.pcnt}`;
}
