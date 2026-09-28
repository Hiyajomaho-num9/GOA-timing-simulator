import * as XLSX from 'xlsx';
import { makeTimingBase } from '../core/time';
import type { CellRef, DraftProject, GpoConfig, GpoEntry } from '../core/types';

export const timing = makeTimingBase(99, 10, 100);
export function cell(address: string): CellRef {
  const c = XLSX.utils.decode_cell(address);
  return { sheet: 'GPIO', address, row: c.r + 1, col: c.c + 1 };
}
export function entry(index: number, lcnt: number, pcnt: number, level: 0 | 1, over: Partial<GpoEntry> = {}): GpoEntry {
  return { index, fcnt: 0x8000 | (level << 14) | (over.frameCount ?? 0), lcnt, pcnt, enabled: true, level, frameCount: 0,
    cells: { fcnt: cell('K' + (index * 3 + 2)), lcnt: cell('K' + (index * 3 + 3)), pcnt: cell('K' + (index * 3 + 4)) }, ...over };
}
export function gpo(over: Partial<GpoConfig> = {}): GpoConfig {
  return { index: 1, soc: 'mt9216', entryEncoding: 'packed-fcnt', code: 'GPO1', group: 'GPO1_STV', label: 'STV',
    combinType: 0, combinSel: 0, maskEnabled: false, regionVst: 0, regionVend: 0, regionPst: 0, regionPend: 0,
    regionOtherValue: 0, repeatCount: 0, repeatMode: 1, lineRepeatStartpoint: 0, perFrameInv: false, frameCntReset: false,
    entries: [entry(0, 0, 10, 1), entry(1, 0, 40, 0)], rows: [], cells: {}, ...over };
}
export function project(gpos = [gpo()]): DraftProject {
  return { timing, gpos, levelShifter: { model: 'none' }, measurements: [], patches: [], dirty: false };
}
export function levelAt(segments: Array<{ start: number; end: number; level: 0 | 1 }>, at: number): number | undefined {
  return segments.find(s => s.start <= at && s.end > at)?.level;
}
export function workbook(): ArrayBuffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Group', 'Name', '', 'Value'], ['Panel', 'PanelHTotal', '', 99], ['Panel', 'PanelVTotal', '', 10],
  ]), 'Panel');
  const rows: unknown[][] = [['Group', 'Name', '', '', '', '', '', '', '', '', 'Value']];
  for (const [name, value] of Object.entries({ Repeat_mode_SEL: 1, Repeat_Count_num: 0,
    entry0_cmd0_: 0xc000, entry0_cmd1_: 0, entry0_cmd2_: 10,
    entry1_cmd0_: 0x8000, entry1_cmd1_: 0, entry1_cmd2_: 40 })) {
    rows.push(['GPO1_STV', name, '', '', '', '', '', '', '', '', value]);
  }
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'GPIO');
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
