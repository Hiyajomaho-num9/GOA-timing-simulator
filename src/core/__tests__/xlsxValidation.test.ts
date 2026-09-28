import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseXlsxBuffer } from '../xlsxParser';
import { workbook } from '../../testSupport/fixtures';

function modify(fn: (book: XLSX.WorkBook) => void): ArrayBuffer {
  const book = XLSX.read(workbook(), { type: 'array' }); fn(book);
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

test('XLSX import: missing Panel or GPIO is rejected instead of using timing defaults', () => {
  for (const name of ['Panel', 'GPIO']) {
    const bytes = modify(book => { delete book.Sheets[name]; book.SheetNames = book.SheetNames.filter(s => s !== name); });
    assert.throws(() => parseXlsxBuffer(bytes, 'invalid.xlsx'), /必需工作表/);
  }
});

test('XLSX import: missing and invalid timing registers are rejected', () => {
  for (const value of [undefined, 'oops', -1, 10.5]) {
    const bytes = modify(book => { if (value === undefined) delete book.Sheets.Panel.D2; else book.Sheets.Panel.D2 = { t: typeof value === 'number' ? 'n' : 's', v: value }; });
    assert.throws(() => parseXlsxBuffer(bytes, 'invalid.xlsx'), /PanelHTotal/);
  }
  assert.throws(() => parseXlsxBuffer(modify(book => { book.Sheets.Panel.D3 = { t: 'n', v: 0 }; }), 'invalid.xlsx'), /PanelVTotal/);
  assert.throws(() => parseXlsxBuffer(workbook(), 'test.xlsx', 0), /frameRate/);
});

test('XLSX import: unrelated GPIO content is rejected', () => {
  const bytes = modify(book => { book.Sheets.GPIO = XLSX.utils.aoa_to_sheet([['header'], ['unrelated']]); });
  assert.throws(() => parseXlsxBuffer(bytes, 'invalid.xlsx'), /GPO entry/);
});
