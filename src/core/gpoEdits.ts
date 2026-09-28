import type { DraftProject, GpoConfig } from './types';

const names = {
  combinType: 'Combin_Type_SEL', combinSel: 'GPO_Combin_SEL', repeatMode: 'Repeat_mode_SEL', repeatCount: 'Repeat_Count_num',
  maskEnabled: 'Mask_region_EN', regionVst: 'Region_VST', regionVend: 'Region_VEND', regionPst: 'Region_pst',
  regionPend: 'Region_pend', regionOtherValue: 'Region_other_Value',
} as const;
export type GpoField = keyof typeof names;

export function applyGpoChange(project: DraftProject, gpo: GpoConfig, key: string, value: number | boolean): boolean {
  if (!(key in names)) throw new Error('不支持的 GPO 参数：' + key);
  const field = key as GpoField;
  if (field === 'maskEnabled' ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('GPO 寄存器值必须是非负整数。');
  }
  if ((field === 'repeatMode' || field === 'regionOtherValue') && value !== 0 && value !== 1) throw new Error(field + ' 只能是 0 或 1。');
  if (field === 'combinType' && Number(value) > 7) throw new Error('Combin type 必须在 0～7。');
  const previous = gpo[field];
  if (previous === value) return false;
  const requested = field === 'combinType' && gpo.soc === 'mt9603' ? 'Logic_function' : names[field];
  const name = Object.keys(gpo.cells).find(name => name.toLowerCase() === requested.toLowerCase());
  const cell = name ? gpo.cells[name] : undefined;
  if (!cell || cell.address === '-') throw new Error(requested + ' 缺少原始单元格地址，未修改。');
  (gpo as unknown as Record<string, unknown>)[field] = value;
  project.patches.push({ sheet: cell.sheet, cell: cell.address, group: gpo.group, name: name!,
    oldValue: typeof previous === 'boolean' ? Number(previous) : previous,
    newValue: typeof value === 'boolean' ? Number(value) : value });
  project.dirty = true;
  return true;
}
