import type { DraftProject, GpoConfig, GpoEntry, PatchItem, TimingBase } from './types';

export type EntryField = 'enabled' | 'level' | 'fcnt' | 'lcnt' | 'pcnt';
export type EntryChanges = Partial<Pick<GpoEntry, EntryField>>;
export type EntryPosition = Pick<GpoEntry, 'lcnt' | 'pcnt'>;

export function entryValidationErrors(gpo: GpoConfig, entry: GpoEntry, timing: TimingBase): string[] {
  const errors: string[] = [];
  const label = gpo.group + ' entry' + entry.index;
  if (Number.isSafeInteger(entry.pcnt) && entry.pcnt > timing.pcntMax) {
    errors.push(label + ': PCNT=' + entry.pcnt + ' 超过限制 ' + timing.pcntMax + '。');
  } else if (!Number.isSafeInteger(entry.pcnt) || entry.pcnt < 0) {
    errors.push(label + ': PCNT 必须是 0～' + timing.pcntMax + ' 的整数。');
  }
  if (!Number.isSafeInteger(entry.lcnt) || entry.lcnt < 0 || entry.lcnt >= timing.vtotal) {
    errors.push(label + ': LCNT 必须是 0～' + (timing.vtotal - 1) + ' 的整数，不能超出当前帧。');
  }
  if (!Number.isSafeInteger(entry.fcnt) || entry.fcnt < 0 || entry.fcnt > 0xffff) {
    errors.push(label + ': FCNT 必须是 0～65535 的整数。');
  }
  if (typeof entry.enabled !== 'boolean' || (entry.level !== 0 && entry.level !== 1)) {
    errors.push(label + ': EN / level 只能是 0 或 1。');
  }
  if (gpo.repeatMode === 1 && entry.enabled && entry.frameCount > gpo.repeatCount) {
    errors.push(label + ': Frame_cnt=' + entry.frameCount + ' 超过 Repeat_Count_num=' + gpo.repeatCount + '。');
  }
  return errors;
}

export function entryPositionError(gpo: GpoConfig, entry: GpoEntry, next: EntryPosition, timing: TimingBase): string | undefined {
  if (gpo.repeatMode === 0 && gpo.soc !== 'mt9603' && next.lcnt !== entry.lcnt) {
    return gpo.group + ' entry' + entry.index + ': by-line 模式不允许修改 LCNT。';
  }
  return entryValidationErrors(gpo, { ...entry, ...next }, timing)[0];
}

export function offsetEntryPosition(entry: GpoEntry, deltaPcnt: number, timing: TimingBase): EntryPosition {
  const at = entry.lcnt * timing.pcntPerLine + entry.pcnt + deltaPcnt;
  return { lcnt: Math.floor(at / timing.pcntPerLine), pcnt: at % timing.pcntPerLine };
}

export function draggedEntryPosition(gpo: GpoConfig, entry: GpoEntry, timing: TimingBase, at: number, periodStart: number): EntryPosition {
  // FCNT already supplies the frame offset; LCNT must remain within that frame.
  const frameOffset = gpo.repeatMode === 1 ? entry.frameCount * timing.pcntPerLine * timing.vtotal : 0;
  const relative = at - periodStart - frameOffset;
  return { lcnt: Math.floor(relative / timing.pcntPerLine), pcnt: relative % timing.pcntPerLine };
}

/** Validate every change and source cell before mutating the entry or patch list. */
export function applyEntryChanges(project: DraftProject, gpo: GpoConfig, entry: GpoEntry, changes: EntryChanges): boolean {
  if (!project.timing) throw new Error('请先导入 XLSX。');
  const next: GpoEntry = { ...entry, ...changes };
  if (!Number.isSafeInteger(next.fcnt) || next.fcnt < 0 || next.fcnt > 0xffff) {
    throw new Error('FCNT 必须是 0～65535 的整数。');
  }
  if (typeof next.enabled !== 'boolean' || (next.level !== 0 && next.level !== 1)) {
    throw new Error('EN / level 只能是 0 或 1。');
  }
  if (gpo.entryEncoding === 'packed-fcnt') {
    if (changes.enabled !== undefined) next.fcnt = next.enabled ? next.fcnt | 0x8000 : next.fcnt & ~0x8000;
    if (changes.level !== undefined) next.fcnt = next.level ? next.fcnt | 0x4000 : next.fcnt & ~0x4000;
    next.enabled = Boolean(next.fcnt & 0x8000);
    next.level = next.fcnt & 0x4000 ? 1 : 0;
    next.frameCount = next.fcnt & 0xff;
  } else {
    next.frameCount = next.fcnt;
  }
  const error = entryPositionError(gpo, entry, next, project.timing);
  if (error) throw new Error(error);
  const fields: EntryField[] = gpo.entryEncoding === 'packed-fcnt'
    ? ['fcnt', 'lcnt', 'pcnt'] : ['enabled', 'level', 'fcnt', 'lcnt', 'pcnt'];
  const patches: PatchItem[] = [];
  for (const field of fields) {
    if (entry[field] === next[field]) continue;
    const cell = entry.cells[field === 'enabled' ? 'enable' : field];
    if (!cell || cell.address === '-') throw new Error(gpo.group + ' entry' + entry.index + ': ' + field + ' 缺少原始单元格地址，未修改。');
    const before = entry[field];
    const after = next[field];
    patches.push({ sheet: cell.sheet, cell: cell.address, group: gpo.group, name: 'entry' + entry.index + '_' + field.toUpperCase(),
      oldValue: typeof before === 'boolean' ? Number(before) : before,
      newValue: typeof after === 'boolean' ? Number(after) : after });
  }
  if (!patches.length) return false;
  Object.assign(entry, next);
  project.patches.push(...patches);
  project.dirty = true;
  return true;
}
