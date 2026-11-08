import { captureDeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { historyReadContextKey, type HistoryDefinitionGroup, type HistoryDefinitionPoint } from './history-read-context'
import type { LiveSnapshot } from './live-snapshot'

export interface FrozenLiveObservation { readonly scope: symbol | null; readonly snapshot: LiveSnapshot }
/** Local comparison scope only. Never rendered, exported or used as physical-source authentication. */
export function liveSnapshotComparisonKey(device: unknown, groups: readonly (HistoryDefinitionGroup & { registers: readonly HistoryDefinitionPoint[] })[]): string | null {
  try {
    const expected = captureDeviceEditBaseline(device)
    const definitions = historyReadContextKey(expected, groups, groups.flatMap(group => group.registers))
    return definitions === null ? null : JSON.stringify([expected, definitions])
  } catch { return null }
}
type Point = LiveSnapshot['points'][number]
export interface SnapshotDifference { readonly id: number; readonly before: Point; readonly after: Point; readonly state: 'changed' | 'unchanged' | 'unknown'; readonly reason?: 'definition' | 'samples' | 'not-new' | 'time' }
function words(snapshot: LiveSnapshot, point: Point) {
  if (!snapshot.device.active || !point.groupActive || point.configuredSlaveId === null || point.display.covered || point.display.invalid || point.health.missing || point.health.stale || ![1, 2, 3, 4].includes(point.definition.functionCode) || point.definition.functionCode !== point.definition.groupFunctionCode || !Number.isSafeInteger(point.definition.address) || point.definition.address < 0 || point.definition.address + point.definition.width > 65536 || ![1, 2, 4].includes(point.definition.width) || point.words.length !== point.definition.width) return null
  const observed = Date.parse(snapshot.observedAt), times: number[] = [], values: number[] = [], batches: Array<string | null> = []
  for (const [index, word] of point.words.entries()) {
    const sample = word.sample, time = sample?.timestampMs ?? Date.parse(sample?.timestamp ?? '')
    if (!sample || word.address !== point.definition.address + index || sample.slaveId !== point.configuredSlaveId || sample.quality !== 'good' || sample.numericIssue || !Number.isSafeInteger(sample.rawValue) || sample.rawValue! < 0 || sample.rawValue! > (point.definition.area === 'coil' || point.definition.area === 'discrete-input' ? 1 : 65535) || !Number.isFinite(observed) || !Number.isFinite(time) || time > observed + 1000 || observed - time > snapshot.thresholdMs) return null
    values.push(sample.rawValue!); times.push(time); batches.push(sample.batchId || null)
  }
  if (values.length > 1 && (point.batchRelationship !== 'complete-same-batch-id' || !batches[0] || batches.some(batch => batch !== batches[0]))) return null
  return { values, times, batch: batches[0] }
}
/** Exact register-word differences only. No subtraction of rounded/64-bit display text, interpolation or PASS/FAIL. */
export function compareLiveSnapshots(before: FrozenLiveObservation | null, after: FrozenLiveObservation | null, scope: symbol | null) {
  const empty = (status: 'empty' | 'context' | 'selection' | 'time') => ({ status, rows: [] as SnapshotDifference[], counts: { changed: 0, unchanged: 0, unknown: 0 } })
  if (!before || !after) return empty('empty')
  const a = before.snapshot, b = after.snapshot
  if (!scope || before.scope !== scope || after.scope !== scope || a.device.id !== b.device.id || a.device.mode !== b.device.mode) return empty('context')
  if (a === b) return empty('empty')
  const left = new Map(a.points.map(point => [point.id, point])), right = new Map(b.points.map(point => [point.id, point]))
  const filters = (value: LiveSnapshot) => JSON.stringify([value.scope.search.trim(), value.scope.source, value.scope.mode])
  if (filters(a) !== filters(b) || left.size !== a.points.length || right.size !== b.points.length || left.size !== right.size || [...left.keys()].some(id => !right.has(id))) return empty('selection')
  if (![a.capturedAt, b.capturedAt].every(time => Number.isFinite(Date.parse(time))) || Date.parse(b.capturedAt) < Date.parse(a.capturedAt)) return empty('time')
  const rows = a.points.map<SnapshotDifference>(previous => {
    const current = right.get(previous.id)!, base = { id: previous.id, before: previous, after: current }
    if (previous.groupId !== current.groupId || previous.configuredSlaveId !== current.configuredSlaveId || JSON.stringify(previous.definition) !== JSON.stringify(current.definition)) return { ...base, state: 'unknown', reason: 'definition' }
    const old = words(a, previous), next = words(b, current)
    if (!old || !next) return { ...base, state: 'unknown', reason: 'samples' }
    if (next.times.some((time, i) => time < old.times[i])) return { ...base, state: 'unknown', reason: 'time' }
    const fresh = old.batch && next.batch ? old.batch !== next.batch : next.times.every((time, i) => time > old.times[i])
    if (!fresh) return { ...base, state: 'unknown', reason: 'not-new' }
    return { ...base, state: next.values.some((value, i) => value !== old.values[i]) ? 'changed' : 'unchanged' }
  })
  const counts = { changed: 0, unchanged: 0, unknown: 0 }; for (const row of rows) counts[row.state]++
  return { status: 'ready' as const, rows, counts }
}
