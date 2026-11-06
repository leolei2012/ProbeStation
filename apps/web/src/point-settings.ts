import { registerWidth } from '../../../packages/core/src/codec'
import { pointEnumChanged, type PointEnumDraft } from './point-enum-draft'

export type PointSettings = { dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null; decimalPlaces?: number | null }
export type PointSettingsDraft = { dataType: string; unit: string; factor: string; offset: string; decimalPlaces: string; rows: readonly { value: string; label: string }[] }
export type PointSettingsUpdate = Omit<PointSettings, 'enumJson'> & { enumJson?: string | null }

/** Build exactly the metadata sent by the editor, without changing configuration or samples. */
export function parsePointSettingsDraft(draft: PointSettingsDraft, originalType: string, available: number, t: (key: string) => string): PointSettings {
  if (draft.dataType !== originalType && registerWidth(draft.dataType) > available) throw new Error(t('valueShort'))
  const factor = Number(draft.factor), offset = Number(draft.offset)
  if (!draft.factor.trim() || !draft.offset.trim() || !Number.isFinite(factor) || !Number.isFinite(offset)) throw new Error(t('pointInvalidScale'))
  const map: Record<string, string> = Object.create(null)
  for (const [enumRowIndex, row] of draft.rows.entries()) {
    const invalid = (message: string): never => { throw Object.assign(new Error(message), { enumRowIndex }) }
    if (!/^-?\d+$/.test(row.value.trim())) invalid(t('enumInvalidValue'))
    const key = BigInt(row.value.trim()).toString()
    if (Object.hasOwn(map, key)) invalid(t('enumDuplicate').replace('{value}', key))
    if (!row.label.trim()) invalid(t('enumEmptyLabel'))
    map[key] = row.label.trim()
  }
  return { dataType: draft.dataType, unit: draft.unit.trim() || null, factor, offset, enumJson: draft.rows.length ? JSON.stringify(map) : null, decimalPlaces: draft.decimalPlaces === '' ? null : Number(draft.decimalPlaces) }
}
/** Unchanged enums are omitted, rather than rewritten from an old snapshot or a lossy row projection. */
export function parsePointSettingsUpdate(draft: Omit<PointSettingsDraft, 'rows'>, enums: PointEnumDraft, originalType: string, available: number, t: (key: string) => string): PointSettingsUpdate {
  const changed = pointEnumChanged(enums), parsed = parsePointSettingsDraft({ ...draft, rows: changed ? enums.rows : [] }, originalType, available, t)
  if (changed) return parsed
  const { enumJson: _unchanged, ...fields } = parsed
  return fields
}
