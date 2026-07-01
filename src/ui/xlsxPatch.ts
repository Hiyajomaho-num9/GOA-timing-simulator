// XLSX patched-export: cell-level zip/xml replacement.
//
// Extracted from render.ts as a self-contained pure module. Operates on the
// original .xlsx ArrayBuffer and a list of PatchItem, rewrites only the
// touched <c> cells inside each sheet XML, and re-zips. Does NOT regenerate
// the whole workbook — this is what lets patched XLSX keep every other cell,
// style and relationship intact.
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import type { DraftProject } from '../core/types';

export function patchXlsxZip(source: ArrayBuffer, patches: DraftProject['patches']): Uint8Array {
  const zip = unzipSync(new Uint8Array(source));
  const sheetPaths = sheetXmlPaths(zip);
  const grouped = new Map<string, DraftProject['patches']>();
  for (const patch of patches) {
    if (patch.cell === '-') continue;
    const list = grouped.get(patch.sheet) ?? [];
    list.push(patch);
    grouped.set(patch.sheet, list);
  }
  for (const [sheetName, sheetPatches] of grouped) {
    const path = sheetPaths.get(sheetName);
    if (!path) throw new Error(`找不到 sheet XML：${sheetName}`);
    const current = zip[path];
    if (!current) throw new Error(`XLSX 内缺少 ${path}`);
    let xml = strFromU8(current);
    for (const patch of sheetPatches) {
      xml = patchSheetCellXml(xml, patch.cell, patch.newValue);
    }
    zip[path] = strToU8(xml);
  }
  return zipSync(zip);
}

function sheetXmlPaths(zip: Unzipped): Map<string, string> {
  const workbookXml = zip['xl/workbook.xml'];
  const relsXml = zip['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !relsXml) throw new Error('XLSX 缺少 workbook.xml 或 workbook.xml.rels。');
  const workbook = strFromU8(workbookXml);
  const rels = strFromU8(relsXml);
  const ridToTarget = new Map<string, string>();
  for (const rel of allMatches(rels, /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*>/g)) {
    ridToTarget.set(xmlDecode(rel[1]), xmlDecode(rel[2]));
  }
  const result = new Map<string, string>();
  for (const sheet of allMatches(workbook, /<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?>/g)) {
    const name = xmlDecode(sheet[1]);
    const rid = xmlDecode(sheet[2]);
    const target = ridToTarget.get(rid);
    if (!target) continue;
    const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    result.set(name, normalized.replace(/\/+/g, '/'));
  }
  return result;
}

function patchSheetCellXml(xml: string, cell: string, value: string | number | null): string {
  const escapedCell = escapeRegExp(cell);
  const cellRe = new RegExp(`<c\\b[^>]*\\br="${escapedCell}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match = xml.match(cellRe);
  const cellXml = makeCellXml(cell, value);
  if (!match) return insertCellXml(xml, cell, cellXml);
  return xml.replace(cellRe, cellXml);
}

function makeCellXml(cell: string, value: string | number | null): string {
  if (typeof value === 'number') return `<c r="${cell}"><v>${value}</v></c>`;
  if (value === null || value === undefined) return `<c r="${cell}"/>`;
  return `<c r="${cell}" t="inlineStr"><is><t>${xmlEncode(String(value))}</t></is></c>`;
}

function insertCellXml(xml: string, cell: string, cellXml: string): string {
  const rowNumber = Number(cell.match(/\d+/)?.[0] ?? 0);
  if (!rowNumber) throw new Error(`无效 cell 地址：${cell}`);
  const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
  const rowMatch = xml.match(rowRe);
  if (!rowMatch) {
    const selfClosingRowRe = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*\\/>`);
    if (selfClosingRowRe.test(xml)) return xml.replace(selfClosingRowRe, (row) => row.replace(/\/>$/, `>${cellXml}</row>`));
    return insertRowXml(xml, rowNumber, cellXml);
  }
  return xml.replace(rowRe, (_whole, open: string, body: string, close: string) => `${open}${insertCellInRow(body, cell, cellXml)}${close}`);
}

function insertRowXml(xml: string, rowNumber: number, cellXml: string): string {
  const sheetDataRe = /(<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>)/;
  const match = xml.match(sheetDataRe);
  if (!match) throw new Error(`sheet XML 中找不到 sheetData，无法插入 row ${rowNumber}。`);
  const body = match[2];
  const rowXml = `<row r="${rowNumber}">${cellXml}</row>`;
  const rows = allMatches(body, /<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g);
  for (const row of rows) {
    if (Number(row[1]) > rowNumber) {
      const index = row.index ?? 0;
      const nextBody = `${body.slice(0, index)}${rowXml}${body.slice(index)}`;
      return xml.replace(sheetDataRe, `${match[1]}${nextBody}${match[3]}`);
    }
  }
  return xml.replace(sheetDataRe, `${match[1]}${body}${rowXml}${match[3]}`);
}

function insertCellInRow(rowBody: string, cell: string, cellXml: string): string {
  const target = cellAddressOrder(cell);
  const cells = allMatches(rowBody, /<c\b[^>]*\br="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g);
  for (const existing of cells) {
    if (cellAddressOrder(existing[1]) > target) {
      const index = existing.index ?? 0;
      return `${rowBody.slice(0, index)}${cellXml}${rowBody.slice(index)}`;
    }
  }
  return `${rowBody}${cellXml}`;
}

function cellAddressOrder(cell: string): number {
  const match = cell.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return Number(match[2]) * 100000 + col;
}

function allMatches(text: string, re: RegExp): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const globalRe = new RegExp(re.source, flags);
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(text))) {
    matches.push(match);
    if (match[0].length === 0) globalRe.lastIndex += 1;
  }
  return matches;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlEncode(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlDecode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}
