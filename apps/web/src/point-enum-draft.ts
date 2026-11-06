export interface PointEnumRow { readonly id: number; readonly value: string; readonly label: string }
export interface PointEnumDraft {
  readonly original: string | null; readonly source: 'empty' | 'map' | 'opaque'; readonly baseline: readonly PointEnumRow[]; readonly rows: readonly PointEnumRow[]
  readonly intent: 'preserve' | 'edit' | 'clear'; readonly nextId: number
}
export type PointEnumAction = { type: 'add' } | { type: 'clear' } | { type: 'restore' } | { type: 'replace-opaque' } | { type: 'remove'; id: number } | { type: 'update'; id: number; field: 'value' | 'label'; text: string }
/** Keep source text separate from the editable projection; JSON parsing must never authorize clearing it. */
export function createPointEnumDraft(original: string | null): PointEnumDraft {
  let source: PointEnumDraft['source'] = original === null ? 'empty' : 'opaque', rows: PointEnumRow[] = []
  if (original !== null) {
    try {
      const map = JSON.parse(original)
      if (map && typeof map === 'object' && !Array.isArray(map) && Object.values(map).every(value => typeof value === 'string')) {
        source = 'map'; rows = Object.entries(map).map(([value, label], id) => Object.freeze({ id, value, label: label as string }))
      }
    } catch { /* Opaque text remains intact and is not converted into an empty mapping. */ }
  }
  const baseline = Object.freeze(rows)
  return Object.freeze({ original, source, baseline, rows: baseline, intent: 'preserve', nextId: rows.length })
}
export function pointEnumChanged(state: PointEnumDraft): boolean {
  if (state.intent === 'preserve') return false
  if (state.intent === 'clear') return state.original !== null
  return state.source === 'opaque' || state.rows.length !== state.baseline.length || state.rows.some((row, i) => row.value !== state.baseline[i].value || row.label !== state.baseline[i].label)
}
export function updatePointEnumDraft(state: PointEnumDraft, action: PointEnumAction): PointEnumDraft {
  if (action.type === 'restore') return Object.freeze({ ...state, rows: state.baseline, intent: 'preserve' })
  if (action.type === 'clear') return Object.freeze({ ...state, rows: Object.freeze([]), intent: 'clear' })
  if (action.type === 'replace-opaque') {
    if (state.source !== 'opaque' || state.intent !== 'preserve') return state
    return Object.freeze({ ...state, rows: Object.freeze([Object.freeze({ id: state.nextId, value: '', label: '' })]), nextId: state.nextId + 1, intent: 'edit' })
  }
  if (state.source === 'opaque' && state.intent === 'preserve') return state
  if (action.type === 'add') return Object.freeze({ ...state, rows: Object.freeze([...state.rows, Object.freeze({ id: state.nextId, value: '', label: '' })]), nextId: state.nextId + 1, intent: 'edit' })
  const index = state.rows.findIndex(row => row.id === action.id)
  if (index < 0 || action.type === 'update' && state.rows[index][action.field] === action.text) return state
  const rows = action.type === 'remove' ? state.rows.filter(row => row.id !== action.id) : state.rows.map(row => row.id === action.id ? Object.freeze({ ...row, [action.field]: action.text }) : row)
  return Object.freeze({ ...state, rows: Object.freeze(rows), intent: 'edit' })
}
