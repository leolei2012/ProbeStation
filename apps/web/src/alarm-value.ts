import { decodeRegister } from '../../../packages/core/src/codec.ts'
import { pointHealth, sampleTime, type Sample } from './observation'

/** Invalid or stale samples are unknown, never a zero or a recovered alarm. */
export function readAlarmValue(dataType: string, words: Array<Sample | undefined>, now: number, threshold: number, paused: boolean, fault: boolean): number | bigint | null {
  const health = pointHealth(words, now, threshold, paused, fault)
  if (!words.length || health.missing || health.stale) return null
  const times = words.map(p => sampleTime(p)!)
  if (Math.max(...times) - Math.min(...times) > 1000 || times.some(time => time > now + 1000) || words.some(p => !Number.isFinite(p!.rawValue))) return null
  const value = decodeRegister(dataType, words.map(p => p!.rawValue))
  return typeof value === 'number' && !Number.isFinite(value) ? null : value
}
