import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseXlsxBuffer } from '../xlsxParser';

// Build a minimal MT9216-style workbook with Panel + GPIO sheets.
function buildWorkbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  // Panel sheet: name in col B (idx 1), value in col D (idx 3). Row 1 is header.
  const panel = XLSX.utils.aoa_to_sheet([
    ['Group', 'Name', 'Field', 'Value'],
    ['Panel', 'PanelHTotal', '', 2170],
    ['Panel', 'PanelVTotal', '', 1140],
  ]);
  XLSX.utils.book_append_sheet(wb, panel, 'Panel');

  // GPIO sheet: group in col A (idx 0), name in col B (idx 1), value in col K (idx 10).
  // One GPO (index 1) with one entry: enable=1, level=1, cmd0 fcnt, cmd1 lcnt=0, cmd2 pcnt=10.
  const gpio = XLSX.utils.aoa_to_sheet([
    ['Group', 'Name', '', '', '', '', '', '', '', '', 'Value'],
    ['GPO1_TEST', 'Combin_Type_SEL', '', '', '', '', '', '', '', '', 0],
    ['GPO1_TEST', 'Repeat_mode_SEL', '', '', '', '', '', '', '', '', 0],
    ['GPO1_TEST', 'Repeat_Count_num', '', '', '', '', '', '', '', '', 0],
    ['GPO1_TEST', 'Mask_region_EN', '', '', '', '', '', '', '', '', 0],
    ['GPO1_TEST', 'entry0_enable', '', '', '', '', '', '', '', '', 1],
    ['GPO1_TEST', 'entry0_Trigger_Value', '', '', '', '', '', '', '', '', 1],
    ['GPO1_TEST', 'entry0_cmd0_', '', '', '', '', '', '', '', '', 0x8001],
    ['GPO1_TEST', 'entry0_cmd1_', '', '', '', '', '', '', '', '', 0],
    ['GPO1_TEST', 'entry0_cmd2_', '', '', '', '', '', '', '', '', 10],
  ]);
  XLSX.utils.book_append_sheet(wb, gpio, 'GPIO');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

test('parseXlsxBuffer: detects MT9216 when no 9603 markers present', () => {
  const parsed = parseXlsxBuffer(buildWorkbook(), 'sample.xlsx', 60);
  assert.equal(parsed.soc, 'mt9216');
});

test('parseXlsxBuffer: timing uses PanelHTotal + 1', () => {
  const parsed = parseXlsxBuffer(buildWorkbook(), 'sample.xlsx', 60);
  assert.equal(parsed.timing.htotalRegister, 2170);
  assert.equal(parsed.timing.htotal, 2171);
  assert.equal(parsed.timing.vtotal, 1140);
  assert.equal(parsed.timing.frameRate, 60);
});

test('parseXlsxBuffer: builds one GPO with correct entry decode (packed-fcnt)', () => {
  const parsed = parseXlsxBuffer(buildWorkbook(), 'sample.xlsx', 60);
  assert.equal(parsed.gpos.length, 1);
  const gpo = parsed.gpos[0];
  assert.equal(gpo.index, 1);
  assert.equal(gpo.group, 'GPO1_TEST');
  assert.equal(gpo.repeatMode, 0);
  assert.equal(gpo.entries.length, 1);
  const e = gpo.entries[0];
  assert.equal(e.enabled, true);
  // packed-fcnt: level from fcnt bit 0x4000. fcnt=0x8001 -> 0x4000 not set -> level 0,
  // but entry0_Trigger_Value=1 also sets level. normalizeEntry for packed-fcnt uses fcnt bits,
  // so level should come from fcnt (0x8001 -> low). Verify against actual decode.
  assert.equal(e.level, 0); // 0x8001: enable bit set, level bit (0x4000) clear -> low
  assert.equal(e.pcnt, 10);
  assert.equal(e.lcnt, 0);
});

test('parseXlsxBuffer: cell refs captured for patch round-trip', () => {
  const parsed = parseXlsxBuffer(buildWorkbook(), 'sample.xlsx', 60);
  const gpo = parsed.gpos[0];
  const pcntCell = gpo.entries[0].cells?.pcnt;
  assert.ok(pcntCell, 'pcnt cell ref captured');
  assert.equal(pcntCell?.sheet, 'GPIO');
  assert.ok(pcntCell?.address.match(/K\d+/), `pcnt cell in K column, got ${pcntCell?.address}`);
});

test('parseXlsxBuffer: detectSocProfile picks MT9603 from filename', () => {
  const parsed = parseXlsxBuffer(buildWorkbook(), 'EPL_MT9603_sample.xlsx', 60);
  assert.equal(parsed.soc, 'mt9603');
});
