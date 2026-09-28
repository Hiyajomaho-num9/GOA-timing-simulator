import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, strToU8, zipSync, unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { patchXlsxZip } from '../xlsxPatch';
import { parseXlsxBuffer } from '../../core/xlsxParser';
import { applyEntryChanges } from '../../core/entryEdits';
import { addMeasurement } from '../../core/measurements';
import { simulateProject } from '../../core/simulator';
import { workbook, project } from '../../testSupport/fixtures';
import type { PatchItem } from '../../core/types';

const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function source(prefixed = false): ArrayBuffer {
  const sheet = prefixed
    ? '<x:worksheet xmlns:x="' + sheetNS + '"><x:dimension ref="K1:L1"/><x:sheetData><x:row r="1"><x:c r="K1" s="5"><x:v>10</x:v></x:c><x:c r="L1" s="7"><x:v>20</x:v></x:c></x:row></x:sheetData></x:worksheet>'
    : '<worksheet xmlns="' + sheetNS + '"><dimension ref="K1:L1"/><sheetData><row r="1" ht="24" customHeight="1"><c r="K1" s="5" cm="1"><f>1+9</f><v>10</v></c><c r="L1" s="7"><v>20</v></c></row></sheetData></worksheet>';
  const data = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns="' + sheetNS + '" xmlns:q="' + relNS + '"><sheets><sheet q:id="rId1" sheetId="1" name="G&#80;IO"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="worksheets/sheet1.xml" Type="' + relNS + '/worksheet" Id="rId1"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8('unchanged-styles'),
    'custom.bin': new Uint8Array([0, 1, 2, 255]),
  });
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
function patch(cell: string, newValue: PatchItem['newValue']): PatchItem { return { sheet: 'GPIO', cell, newValue, oldValue: 10, group: 'GPO1', name: 'PCNT' }; }
function readSheet(bytes: Uint8Array) { return new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']), 'application/xml'); }

test('XLSX export: reordered attributes and namespace aliases work; styles and unrelated ZIP entries remain intact', () => {
  const original = source(), out = patchXlsxZip(original, [patch('K1', 11)]), doc = readSheet(out);
  const cells = Array.from(doc.getElementsByTagNameNS('*', 'c'));
  assert.equal(cells[0].getAttribute('s'), '5');
  assert.equal(cells[0].getAttribute('cm'), '1');
  assert.equal(cells[0].getElementsByTagNameNS('*', 'f').length, 0);
  assert.equal(cells[0].getElementsByTagNameNS('*', 'v')[0].textContent, '11');
  assert.equal(cells[1].getAttribute('s'), '7');
  assert.equal(cells[1].textContent, '20');
  assert.equal(doc.getElementsByTagNameNS('*', 'row')[0].getAttribute('ht'), '24');
  const before = unzipSync(new Uint8Array(original)), after = unzipSync(out);
  for (const file of Object.keys(before).filter(p => p !== 'xl/worksheets/sheet1.xml')) assert.deepEqual(after[file], before[file], file);
});

test('XLSX export: inserting cells preserves ordering, namespaces and used range', () => {
  const doc = readSheet(patchXlsxZip(source(true), [patch('M3', 30), patch('A1', 1)]));
  assert.deepEqual(Array.from(doc.getElementsByTagNameNS('*', 'c')).map(c => c.getAttribute('r')), ['A1', 'K1', 'L1', 'M3']);
  assert.equal(doc.getElementsByTagNameNS('*', 'dimension')[0].getAttribute('ref'), 'A1:M3');
  assert.ok(Array.from(doc.getElementsByTagNameNS('*', 'c')).every(c => c.namespaceURI === sheetNS));
});

test('XLSX export: string whitespace and XML characters survive; clearing retains the style', () => {
  const text = ' <value> & "quoted" ';
  const written = patchXlsxZip(source(), [patch('K1', text)]);
  let doc = readSheet(written);
  assert.equal(doc.getElementsByTagNameNS('*', 't')[0].textContent, text);
  const cleared = patchXlsxZip(written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength) as ArrayBuffer, [patch('K1', null)]);
  doc = readSheet(cleared);
  const c = doc.getElementsByTagNameNS('*', 'c')[0];
  assert.equal(c.getAttribute('s'), '5');
  assert.equal(c.textContent, '');
  assert.equal(c.hasAttribute('t'), false);
});

test('XLSX export: reject invalid addresses and non-finite values instead of dropping patches', () => {
  for (const cell of ['-', 'A0', 'XFE1', 'A1048577']) assert.throws(() => patchXlsxZip(source(), [patch(cell, 1)]), /地址/);
  for (const value of [NaN, Infinity]) assert.throws(() => patchXlsxZip(source(), [patch('K1', value)]), /非有限/);
});

test('editing/export integration: edit → measure → export → reimport keeps the same pulse duration', () => {
  const bytes = workbook(), parsed = parseXlsxBuffer(bytes, 'test.xlsx', 100);
  const p = { ...project(parsed.gpos), timing: parsed.timing };
  const edges = simulateProject(p).gpoSignals.find(s => s.id === 'gpo:1:merge')!.edges;
  const m = addMeasurement(p, edges[0], edges[1]); m.targetInput = '40pcnt';
  applyEntryChanges(p, p.gpos[0], p.gpos[0].entries[1], { pcnt: 50 });
  assert.equal(simulateProject(p).measurements[0].deltaPcnt, 40);
  const out = patchXlsxZip(bytes, p.patches);
  const restored = parseXlsxBuffer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, 'patched.xlsx', 100);
  assert.equal(restored.gpos[0].entries[1].pcnt, 50);
  assert.equal(simulateProject({ ...p, gpos: restored.gpos }).measurements[0].deltaPcnt, 40);
  const xlsx = XLSX.read(out, { type: 'array' });
  assert.equal(xlsx.Sheets.GPIO[p.patches[0].cell].v, 50);
});
