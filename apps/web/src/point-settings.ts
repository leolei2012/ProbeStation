import { registerWidth } from '../../../packages/core/src/codec'

export type PointSettings = { dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null; decimalPlaces?: number | null }
export type PointSettingsDraft = { dataType: string; unit: string; factor: string; offset: string; decimalPlaces: string; rows: readonly { value: string; label: string }[] }

/** Build exactly the metadata sent by the editor, without changing configuration or samples. */
export function parsePointSettingsDraft(draft: PointSettingsDraft, originalType: string, available: number, t: (key: string) => string): PointSettings {
  if (draft.dataType !== originalType && registerWidth(draft.dataType) > available) throw new Error(t('valueShort'))
  const factor = Number(draft.factor), offset = Number(draft.offset)
  if (!draft.factor.trim() || !draft.offset.trim() || !Number.isFinite(factor) || !Number.isFinite(offset)) throw new Error(t('pointInvalidScale'))
  const map: Record<string, string> = Object.create(null)
  for (const row of draft.rows) {
    if (!/^-?\d+$/.test(row.value.trim())) throw new Error(t('enumInvalidValue'))
    const key = BigInt(row.value.trim()).toString()
    if (Object.hasOwn(map, key)) throw new Error(t('enumDuplicate').replace('{value}', key))
    if (!row.label.trim()) throw new Error(t('enumEmptyLabel'))
    map[key] = row.label.trim()
  }
  return { dataType: draft.dataType, unit: draft.unit.trim() || null, factor, offset, enumJson: draft.rows.length ? JSON.stringify(map) : null, decimalPlaces: draft.decimalPlaces === '' ? null : Number(draft.decimalPlaces) }
}
