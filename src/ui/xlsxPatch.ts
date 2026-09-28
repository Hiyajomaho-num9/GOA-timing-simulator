// Patch only the selected sheet ZIP entries; preserve cell attributes and unrelated ZIP members.
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import type { DraftProject } from '../core/types';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export function patchXlsxZip(source: ArrayBuffer, patches: DraftProject['patches']): Uint8Array {
  const zip = unzipSync(new Uint8Array(source));
  const paths = sheetXmlPaths(zip);
  const groups = new Map<string, DraftProject['patches']>();
  for (const patch of patches) {
    cellPosition(patch.cell);
    if (typeof patch.newValue === 'number' && !Number.isFinite(patch.newValue)) throw new Error('不能导出非有限数值：' + patch.cell);
    const group = groups.get(patch.sheet) ?? [];
    group.push(patch);
    groups.set(patch.sheet, group);
  }
  for (const [name, group] of groups) {
    const path = paths.get(name);
    if (!path || !zip[path]) throw new Error('找不到 sheet XML：' + name);
    const doc = parseXml(strFromU8(zip[path]), path);
    const data = elements(doc, 'sheetData')[0];
    if (!data) throw new Error('sheet XML 缺少 sheetData：' + name);
    const rows = new Map(elements(data, 'row').map(row => [Number(row.getAttribute('r')), row]));
    const cells = new Map(elements(data, 'c').map(cell => [(cell.getAttribute('r') ?? '').toUpperCase(), cell]));
    for (const patch of group) {
      const address = patch.cell.toUpperCase();
      const pos = cellPosition(address);
      let cell = cells.get(address);
      if (!cell) {
        let row = rows.get(pos.row);
        if (!row) {
          row = createElement(doc, data, 'row');
          row.setAttribute('r', String(pos.row));
          const next = elements(data, 'row').find(item => Number(item.getAttribute('r')) > pos.row);
          data.insertBefore(row, next ?? null);
          rows.set(pos.row, row);
        }
        cell = createElement(doc, row, 'c');
        cell.setAttribute('r', address);
        const next = elements(row, 'c').find(item => cellPosition(item.getAttribute('r') ?? '').col > pos.col);
        row.insertBefore(cell, next ?? null);
        cells.set(address, cell);
        extendDimension(doc, address);
      }
      setCellValue(doc, cell, patch.newValue);
    }
    zip[path] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  return zipSync(zip);
}

function parseXml(xml: string, name: string): Document {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('XLSX XML 不允许 DOCTYPE：' + name);
  return new DOMParser({ onError: (_level, message) => { throw new Error(name + ': ' + message); } })
    .parseFromString(xml, 'application/xml');
}

function elements(parent: Document | Element, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', localName));
}

function createElement(doc: Document, parent: Element, localName: string): Element {
  return doc.createElementNS(parent.namespaceURI, parent.prefix ? parent.prefix + ':' + localName : localName);
}

function sheetXmlPaths(zip: Unzipped): Map<string, string> {
  if (!zip['xl/workbook.xml'] || !zip['xl/_rels/workbook.xml.rels']) throw new Error('XLSX 缺少 workbook.xml 或 workbook.xml.rels。');
  const workbook = parseXml(strFromU8(zip['xl/workbook.xml']), 'workbook.xml');
  const rels = parseXml(strFromU8(zip['xl/_rels/workbook.xml.rels']), 'workbook.xml.rels');
  const targets = new Map<string, string>();
  for (const rel of elements(rels, 'Relationship')) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) targets.set(id, normalizeTarget(target));
  }
  const result = new Map<string, string>();
  for (const sheet of elements(workbook, 'sheet')) {
    const id = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');
    const name = sheet.getAttribute('name');
    const target = id ? targets.get(id) : undefined;
    if (name && target) result.set(name, target);
  }
  return result;
}

function normalizeTarget(target: string): string {
  const parts: string[] = [];
  for (const part of (target.startsWith('/') ? target.slice(1) : 'xl/' + target).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('无效 XLSX 关系路径：' + target);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function setCellValue(doc: Document, cell: Element, value: string | number | null): void {
  // Keep r/s/cm/vm and other attributes; replacing the value intentionally removes the old formula.
  for (const node of Array.from(cell.childNodes)) {
    if (node.nodeType === 1 && ['f', 'v', 'is'].includes((node as Element).localName ?? node.nodeName)) cell.removeChild(node);
  }
  cell.removeAttribute('t');
  if (value === null) return;
  if (typeof value === 'number') {
    const v = createElement(doc, cell, 'v');
    v.appendChild(doc.createTextNode(String(value)));
    cell.insertBefore(v, cell.firstChild);
  } else {
    cell.setAttribute('t', 'inlineStr');
    const inline = createElement(doc, cell, 'is');
    const text = createElement(doc, cell, 't');
    if (value.trim() !== value) text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    text.appendChild(doc.createTextNode(value));
    inline.appendChild(text);
    cell.insertBefore(inline, cell.firstChild);
  }
}

function cellPosition(cell: string): { row: number; col: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(cell);
  if (!match) throw new Error('无效 cell 地址：' + cell);
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (col > 16384 || row > 1048576) throw new Error('cell 地址超过 XLSX 范围：' + cell);
  return { row, col };
}

function cellAddress(col: number, row: number): string {
  let name = '';
  for (let value = col; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name + row;
}

function extendDimension(doc: Document, address: string): void {
  const dimension = elements(doc, 'dimension')[0];
  if (!dimension) return;
  const refs = (dimension.getAttribute('ref') ?? address).split(':');
  const points = [cellPosition(refs[0]), cellPosition(refs[1] ?? refs[0]), cellPosition(address)];
  const start = cellAddress(Math.min(...points.map(p => p.col)), Math.min(...points.map(p => p.row)));
  const end = cellAddress(Math.max(...points.map(p => p.col)), Math.max(...points.map(p => p.row)));
  dimension.setAttribute('ref', start === end ? start : start + ':' + end);
}
