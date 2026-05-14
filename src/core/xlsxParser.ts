import * as XLSX from 'xlsx';
import type { CellRef, CombinType, EntryEncoding, GpoConfig, GpoEntry, LogicLevel, ParsedWorkbook, SheetRow, SocProfile } from './types';
import { makeTimingBase } from './time';

const GPIO_SHEET = 'GPIO';
const PANEL_SHEET = 'Panel';
const VALUE_COL_GPIO = 10;
const VALUE_COL_PANEL = 3;
export type SocProfileSelection = SocProfile | 'auto';

export async function parseXlsxFile(file: File, frameRate = 60, socProfile: SocProfileSelection = 'auto'): Promise<ParsedWorkbook> {
  const buffer = await file.arrayBuffer();
  return parseXlsxBuffer(buffer, file.name, frameRate, socProfile);
}

export function parseXlsxBuffer(buffer: ArrayBuffer, fileName: string, frameRate = 60, socProfile: SocProfileSelection = 'auto'): ParsedWorkbook {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const soc = socProfile === 'auto' ? detectSocProfile(workbook, fileName) : socProfile;
  const timing = parseTiming(workbook, frameRate, soc);
  const gpioRows = parseRows(workbook, GPIO_SHEET, VALUE_COL_GPIO);
  const gpos = buildGpos(gpioRows, soc);
  return { workbook, fileName, soc, timing, gpioRows, gpos };
}

export function parseTiming(workbook: XLSX.WorkBook, frameRate = 60, soc: SocProfile = 'mt9216') {
  const panelRows = parseRows(workbook, PANEL_SHEET, VALUE_COL_PANEL);
  const htotalRegister = findNumeric(panelRows, 'PanelHTotal') ?? 2199;
  const vtotal = findNumeric(panelRows, 'PanelVTotal') ?? 1126;
  const panelMinHtotal = findNumeric(panelRows, 'PanelMinHTotal');
  const panelMinVtotal = findNumeric(panelRows, 'PanelMinVTotal');
  const panelDclk = findNumeric(panelRows, 'PanelDCLK');
  const htotalArg = soc === 'mt9603' ? htotalRegister - 1 : htotalRegister;
  return makeTimingBase(htotalArg, vtotal, frameRate, { soc, panelMinHtotal, panelMinVtotal, panelDclk });
}

export function parseRows(workbook: XLSX.WorkBook, sheetName: string, valueCol: number): SheetRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) return [];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows: SheetRow[] = [];
  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const group = cellText(sheet, r, 0);
    const name = cellText(sheet, r, 1);
    if (!group && !name) continue;
    const valueAddress = XLSX.utils.encode_cell({ r, c: valueCol });
    rows.push({
      sheet: sheetName,
      row: r + 1,
      group,
      name,
      value: cellRaw(sheet, r, valueCol),
      valueCell: { sheet: sheetName, address: valueAddress, row: r + 1, col: valueCol + 1 },
    });
  }
  return rows;
}

function findNumeric(rows: SheetRow[], name: string): number | undefined {
  const row = rows.find((r) => normalize(r.name) === normalize(name));
  return row ? parseNumber(row.value) : undefined;
}

export function buildGpos(rows: SheetRow[], soc: SocProfile = 'mt9216'): GpoConfig[] {
  const groups = new Map<number, SheetRow[]>();
  for (const row of rows) {
    const idx = parseGpoIndex(row.group);
    if (idx === undefined) continue;
    if (isCommonGpoGroup(row.group)) continue;
    const list = groups.get(idx) ?? [];
    list.push(row);
    groups.set(idx, list);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, groupRows]) => buildGpo(index, groupRows, soc));
}

function buildGpo(index: number, rows: SheetRow[], soc: SocProfile): GpoConfig {
  const group = rows.find((r) => r.group)?.group ?? `GPO${index.toString(16).toUpperCase()}`;
  const get = (name: string, fallback = 0) => parseNumber(rows.find((r) => normalize(r.name) === normalize(name))?.value) ?? fallback;
  const cells: Partial<Record<string, CellRef>> = {};
  for (const row of rows) cells[row.name] = row.valueCell;

  const entryEncoding: EntryEncoding = soc === 'mt9603' ? 'split-fields' : 'packed-fcnt';
  const entryMap = new Map<number, Partial<GpoEntry>>();
  for (const row of rows) {
    const entryMatch = row.name.match(/entry(\d+)/i);
    if (!entryMatch) continue;
    const entryIndex = Number(entryMatch[1]);
    const partial = entryMap.get(entryIndex) ?? { index: entryIndex, fcnt: 0, lcnt: 0, pcnt: 0, enabled: false, level: 0, frameCount: 0, cells: {} };
    const value = parseNumber(row.value) ?? 0;

    const cmdMatch = row.name.match(/entry\d+_cmd([012])_/i);
    if (/entry\d+_enable/i.test(row.name)) {
      partial.enabled = value === 1 || Boolean(value & 0x8000);
      partial.cells = { ...(partial.cells ?? {}), enable: row.valueCell };
    } else if (/entry\d+_Trigger_Value/i.test(row.name)) {
      partial.level = asLevel(value);
      partial.cells = { ...(partial.cells ?? {}), level: row.valueCell };
    } else if (cmdMatch && Number(cmdMatch[1]) === 0) {
      partial.fcnt = value;
      partial.frameCount = entryEncoding === 'split-fields' ? value : value & 0xff;
      partial.cells = { ...(partial.cells ?? {}), fcnt: row.valueCell };
    } else if (cmdMatch && Number(cmdMatch[1]) === 1) {
      partial.lcnt = value;
      partial.cells = { ...(partial.cells ?? {}), lcnt: row.valueCell };
    } else if (cmdMatch && Number(cmdMatch[1]) === 2) {
      partial.pcnt = value;
      partial.cells = { ...(partial.cells ?? {}), pcnt: row.valueCell };
    }
    entryMap.set(entryIndex, partial);
  }

  const entries = [...entryMap.values()]
    .map((entry) => normalizeEntry(entry as GpoEntry, entryEncoding))
    .sort((a, b) => a.index - b.index);

  return {
    index,
    soc,
    entryEncoding,
    code: `GPO${index}`,
    group,
    label: group.replace(/^GPO\d+_?/i, '') || group,
    combinType: clampCombin(get('Combin_Type_SEL', get('Logic_function'))),
    combinSel: get('GPO_Combin_SEL'),
    maskEnabled: get('Mask_region_EN') === 1,
    regionVst: get('Region_VST'),
    regionVend: get('Region_VEND'),
    regionPst: get('Region_pst'),
    regionPend: get('Region_pend'),
    regionOtherValue: asLevel(get('Region_other_Value')),
    repeatCount: get('Repeat_Count_num'),
    repeatMode: get('Repeat_mode_SEL') === 1 ? 1 : 0,
    lineRepeatStartpoint: get('Line_repeat_Startpoint'),
    perFrameInv: get(`gpo${index.toString(16).toLowerCase()}_per_frame_inv`) === 1,
    frameCntReset: get('Frame_CNTreset') === 1,
    entries,
    rows,
    cells,
  };
}

function normalizeEntry(entry: GpoEntry, encoding: EntryEncoding): GpoEntry {
  const fcnt = entry.fcnt ?? 0;
  const split = encoding === 'split-fields';
  return {
    ...entry,
    fcnt,
    lcnt: entry.lcnt ?? 0,
    pcnt: entry.pcnt ?? 0,
    enabled: split ? Boolean(entry.enabled) : Boolean(fcnt & 0x8000),
    level: split ? asLevel(entry.level ?? 0) : (fcnt & 0x4000 ? 1 : 0) as LogicLevel,
    frameCount: split ? (entry.frameCount ?? fcnt ?? 0) : fcnt & 0xff,
    cells: entry.cells ?? {},
  };
}

export function parseGpoIndex(group: string): number | undefined {
  const match = String(group ?? '').match(/^GPO(\d+|[A-F])/i);
  if (!match) return undefined;
  return /[A-F]/i.test(match[1]) ? Number.parseInt(match[1], 16) : Number.parseInt(match[1], 10);
}

export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const parsed = text.toLowerCase().startsWith('0x') ? Number.parseInt(text, 16) : Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampCombin(value: number): CombinType {
  return Math.max(0, Math.min(7, value)) as CombinType;
}

function asLevel(value: number): LogicLevel {
  return value ? 1 : 0;
}

function detectSocProfile(workbook: XLSX.WorkBook, fileName: string): SocProfile {
  if (/9603|9633/i.test(fileName)) return 'mt9603';
  const main = workbook.Sheets.Main;
  const version = workbook.Sheets.Version;
  const mainText = main ? JSON.stringify(XLSX.utils.sheet_to_json(main, { header: 1, raw: false, defval: '' })).toLowerCase() : '';
  const versionText = version ? JSON.stringify(XLSX.utils.sheet_to_json(version, { header: 1, raw: false, defval: '' })).toLowerCase() : '';
  if (/mt9603|mt9633|cmpi|tconless/.test(`${mainText} ${versionText}`)) return 'mt9603';
  return 'mt9216';
}

function isCommonGpoGroup(group: string): boolean {
  return /^GPO\d+_\d+\s+Common setting/i.test(String(group ?? ''));
}

function normalize(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function cellText(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const raw = cellRaw(sheet, r, c);
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function cellRaw(sheet: XLSX.WorkSheet, r: number, c: number): string | number | null {
  const address = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[address];
  return cell ? (cell.v as string | number | null) : null;
}
