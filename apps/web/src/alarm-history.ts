import { historyPointSourceKey } from './history-navigation'
import { alarmMatches, type AlarmRule } from '../../../packages/core/src/alarm'
import type { AlarmObservation } from './alarm-value'
import type { DataTarget } from './DeviceIssues'
import { historyTimeRange, resolveHistoryTimeRange } from './history-time-range'
import { validSlaveId } from '../../../packages/core/src/sample-source'
import { registerWidth } from '../../../packages/core/src/codec'

export type AlarmHistoryState = { kind: 'waiting' | 'rules' | 'inactive' | 'identity' | 'batch' | 'time' } | { kind: 'ready'; target: Readonly<DataTarget>; sampledAt: string; slaveId: number; registerId: number; batchKnown: boolean }
/** A preceding display window, not a trigger time, recorded alarm event or proof of persisted data. */
export function alarmHistoryState(observation: AlarmObservation | null, rule: AlarmRule, point: { id: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }, deviceId: number, configurationReady: boolean, rulesReady: boolean, now: number, staleMs: number): AlarmHistoryState {
  if (!configurationReady) return { kind: 'waiting' }
  if (!rulesReady) return { kind: 'rules' }
  if (!observation || !alarmMatches(observation.value, rule.operator, rule.threshold)) return { kind: 'inactive' }
  if (!Number.isSafeInteger(deviceId) || deviceId < 1 || observation.objectId !== deviceId || !Number.isSafeInteger(point.id) || point.id < 1 || !Number.isSafeInteger(rule.id) || rule.id < 1 || observation.registerId !== point.id || rule.registerId !== point.id || observation.functionCode !== point.functionCode || observation.address !== point.startAddress || observation.dataType !== point.dataType || !validSlaveId(observation.slaveId) || observation.width !== registerWidth(point.dataType)) return { kind: 'identity' }
  if (observation.width > 1 && !observation.batchId) return { kind: 'batch' }
  const pointSource = historyPointSourceKey({ ...point, slaveId: observation.slaveId })
  if (!pointSource) return { kind: 'identity' }
  const time = observation.sampledAt
  if (time === null || !Number.isSafeInteger(time) || !Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0 || time > now || now - time > staleMs) return { kind: 'time' }
  const range = resolveHistoryTimeRange(historyTimeRange(time - 5 * 60_000, time, 'utc'))
  if (!range.valid) return { kind: 'time' }
  const sampledAt = new Date(time).toISOString()
  return Object.freeze({ kind: 'ready', target: Object.freeze({ deviceId, view: 'history', registerId: point.id, start: new Date(range.start).toISOString(), end: sampledAt, valueMode: 'raw', pointSource, label: point.alias || '#' + point.id }), sampledAt, slaveId: observation.slaveId, registerId: point.id, batchKnown: observation.batchId !== null })
}
/** Resolve again at click time so an expired displayed sample cannot initiate navigation. */
export function openAlarmHistory(resolve: () => AlarmHistoryState, onOpen: (target: Readonly<DataTarget>) => void) {
  const next = resolve()
  if (next.kind === 'ready') onOpen(next.target)
  return next
}
