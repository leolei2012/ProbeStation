export type HistoryInputZone = 'local' | 'utc'
export interface HistoryTimeField { readonly text: string; readonly instant: number | null }
export interface HistoryTimeRange { readonly zone: HistoryInputZone; readonly start: HistoryTimeField; readonly end: HistoryTimeField }
type Parts = [number, number, number, number, number, number, number]
const pad = (value: number, width = 2) => String(value).padStart(width, '0')
function partsOf(date: Date, zone: HistoryInputZone): Parts {
  return zone === 'utc' ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()] : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
}
const equal = (a: Parts, b: Parts) => a.every((value, i) => value === b[i])
function dateOf(parts: Parts, zone: HistoryInputZone) {
  const [year, month, day, hour, minute, second, millisecond] = parts, date = new Date(0)
  // FullYear setters avoid JavaScript's special 1900 offset for numeric years 00–99.
  if (zone === 'utc') { date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, millisecond) }
  else { date.setFullYear(year, month - 1, day); date.setHours(hour, minute, second, millisecond) }
  return date
}
function parseParts(text: string): Parts | null {
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text)
  if (!match) return null
  const parts: Parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0), Number((match[7] ?? '').padEnd(3, '0'))]
  if (parts[0] < 1 || !Number.isFinite(dateOf(parts, 'utc').getTime()) || !equal(parts, partsOf(dateOf(parts, 'utc'), 'utc'))) return null
  return parts
}
export function formatHistoryTime(instant: number, zone: HistoryInputZone): string {
  const date = new Date(instant)
  if (!Number.isFinite(date.getTime())) return ''
  const [year, month, day, hour, minute, second, ms] = partsOf(date, zone)
  if (year < 1) return '' // datetime-local has no representation for BCE/year zero.
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(ms, 3)}`
}
function absoluteField(instant: number, zone: HistoryInputZone): HistoryTimeField {
  const normalized = new Date(instant).getTime(), text = formatHistoryTime(normalized, zone)
  return Object.freeze({ text, instant: text ? normalized : null })
}
export function historyTimeRange(start: number, end: number, zone: HistoryInputZone = 'local'): HistoryTimeRange {
  return Object.freeze({ zone, start: absoluteField(start, zone), end: absoluteField(end, zone) })
}
function resolveField(field: HistoryTimeField, zone: HistoryInputZone): number {
  if (field.instant !== null) {
    return Number.isSafeInteger(field.instant) && formatHistoryTime(field.instant, zone) ? field.instant : NaN
  }
  const parts = parseParts(field.text)
  if (!parts) return NaN
  const date = dateOf(parts, zone)
  // Reject normalized calendar dates and nonexistent spring-forward times instead of moving the interval.
  return equal(parts, partsOf(date, zone)) ? date.getTime() : NaN
}
export function historyTimeText(field: HistoryTimeField, zone: HistoryInputZone): string {
  return field.instant === null ? field.text : formatHistoryTime(field.instant, zone)
}
export function resolveHistoryTimeRange(range: HistoryTimeRange) {
  const start = resolveField(range.start, range.zone), end = resolveField(range.end, range.zone), fieldsValid = Number.isFinite(start) && Number.isFinite(end)
  return { start, end, fieldsValid, valid: fieldsValid && start < end }
}
export function editHistoryTime(range: HistoryTimeRange, field: 'start' | 'end', text: string): HistoryTimeRange {
  const displayed = historyTimeText(range[field], range.zone), before = parseParts(displayed), after = parseParts(text)
  // Native controls can omit :00.000 without changing wall time. Retain imported absolute identity.
  if (text === displayed || before && after && equal(before, after)) return range
  const draft = Object.freeze({ text, instant: null }), instant = resolveField(draft, range.zone)
  return Object.freeze({ ...range, [field]: Number.isFinite(instant) ? absoluteField(instant, range.zone) : draft })
}
export function changeHistoryInputZone(range: HistoryTimeRange, zone: HistoryInputZone): HistoryTimeRange {
  if (zone === range.zone) return range
  const resolved = resolveHistoryTimeRange(range)
  return resolved.fieldsValid ? historyTimeRange(resolved.start, resolved.end, zone) : range
}
export function historyPresetRange(minutes: number, now: number, zone: HistoryInputZone): HistoryTimeRange {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return historyTimeRange(NaN, NaN, zone)
  const localMidnight = new Date(now); localMidnight.setHours(0, 0, 0, 0)
  return historyTimeRange(minutes === 0 ? localMidnight.getTime() : now - minutes * 60_000, now, zone)
}
export function historyTimeOffset(instant: number, zone: HistoryInputZone): string {
  const date = new Date(instant), normalized = date.getTime()
  if (!Number.isFinite(normalized)) return '—'
  const offset = zone === 'utc' ? 0 : dateOf(partsOf(date, 'local'), 'utc').getTime() - normalized
  if (!Number.isFinite(offset)) return '—'
  const seconds = Math.abs(offset) / 1000, remainder = seconds % 60
  return `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds % 3600 / 60))}${remainder ? ':' + pad(remainder) : ''}`
}
