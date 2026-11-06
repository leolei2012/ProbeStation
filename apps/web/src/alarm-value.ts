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

/** Select the configured source before applying the existing alarm quality/batch checks. */
export function readPointAlarmValue(reg: { dataType: string; functionCode: number; startAddress: number }, latest: Record<string, Sample>, device: { id: number; isActive: number; mode?: string; slaveId?: number }, group: { isActive: number; slaveId?: number }, now: number, threshold: number, fault: boolean): number | bigint | null {
  const slaveId = device.mode === 'slave' ? device.slaveId : group.slaveId
  if (!validSlaveId(slaveId)) return null
  const area = reg.functionCode === 1 ? 'coil' : reg.functionCode === 2 ? 'discrete-input' : reg.functionCode === 4 ? 'input-register' : 'holding-register'
  const words = Array.from({ length: registerWidth(reg.dataType) }, (_, i) => sourceSample(latest, device.id, area, reg.startAddress + i, slaveId))
  return readAlarmValue(reg.dataType, words, now, threshold, !device.isActive || !group.isActive, fault)
}
