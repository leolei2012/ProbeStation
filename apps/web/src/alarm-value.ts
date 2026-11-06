import { decodeRegister, registerWidth } from '../../../packages/core/src/codec.ts'
import { pointHealth, sampleTime, type Sample } from './observation'
import { sameResponseBatch } from '../../../packages/core/src/sample-batch.ts'
import { sourceSample, validSlaveId } from '../../../packages/core/src/sample-source.ts'

/** Invalid or stale samples are unknown, never a zero or a recovered alarm. */
export function readAlarmValue(dataType: string, words: Array<Sample | undefined>, now: number, threshold: number, paused: boolean, fault: boolean): number | bigint | null {
  const health = pointHealth(words, now, threshold, paused, fault)
  if (!words.length || health.missing || health.stale || !sameResponseBatch(words)) return null
  const times = words.map(p => sampleTime(p)!)
  if (Math.max(...times) - Math.min(...times) > 1000 || times.some(time => time > now + 1000) || words.some(p => !Number.isFinite(p!.rawValue))) return null
  const value = decodeRegister(dataType, words.map(p => p!.rawValue))
  return typeof value === 'number' && !Number.isFinite(value) ? null : value
}

type AlarmPoint = { id?: number; dataType: string; functionCode: number; startAddress: number }
type AlarmDevice = { id: number; isActive: number; mode?: string; slaveId?: number }
type AlarmGroup = { isActive: number; slaveId?: number }
export interface AlarmObservation {
  readonly value: number | bigint; readonly objectId: number; readonly registerId: number | null; readonly functionCode: number; readonly address: number; readonly dataType: string
  readonly slaveId: number; readonly width: number; readonly sampledAt: number | null; readonly batchId: string | null
}
/** Project the exact words used for the existing value evaluation, never a second cache lookup. */
export function readPointAlarmObservation(reg: AlarmPoint, latest: Record<string, Sample>, device: AlarmDevice, group: AlarmGroup, now: number, threshold: number, fault: boolean): AlarmObservation | null {
  const slaveId = device.mode === 'slave' ? device.slaveId : group.slaveId
  if (!validSlaveId(slaveId)) return null
  const area = reg.functionCode === 1 ? 'coil' : reg.functionCode === 2 ? 'discrete-input' : reg.functionCode === 4 ? 'input-register' : 'holding-register'
  const words = Array.from({ length: registerWidth(reg.dataType) }, (_, i) => sourceSample(latest, device.id, area, reg.startAddress + i, slaveId))
  const value = readAlarmValue(reg.dataType, words, now, threshold, !device.isActive || !group.isActive, fault)
  if (value === null) return null
  const times = words.map(word => sampleTime(word)!), batch = words[0]?.batchId
  return Object.freeze({ value, objectId: device.id, registerId: reg.id ?? null, functionCode: reg.functionCode, address: reg.startAddress, dataType: reg.dataType, slaveId, width: words.length,
    sampledAt: times.every(time => time === times[0]) ? times[0] : null, batchId: typeof batch === 'string' && batch.length > 0 && words.every(word => word?.batchId === batch) ? batch : null })
}
/** Select the configured source before applying the existing alarm quality/batch checks. */
export function readPointAlarmValue(reg: AlarmPoint, latest: Record<string, Sample>, device: AlarmDevice, group: AlarmGroup, now: number, threshold: number, fault: boolean): number | bigint | null {
  return readPointAlarmObservation(reg, latest, device, group, now, threshold, fault)?.value ?? null
}
