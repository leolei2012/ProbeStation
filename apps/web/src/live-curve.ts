import { decodeRegister, registerWidth } from '../../../packages/core/src/codec.ts'
import { sampleTime, type Sample } from './observation'

export interface CurveRegister { id: number; startAddress: number; dataType: string; functionCode: number }
export interface CurveTrack { signature: string; times: number[]; points: Array<[number, number | null]> }
export type CurveBuffer = Record<number, CurveTrack>
export const CURVE_LIMIT = 2400

/** Bounded display sampling; never repeat an unchanged snapshot or join partial multiword updates. */
export function sampleCurve(previous: CurveBuffer, registers: CurveRegister[], latest: Record<string, Sample>, objectId: number, now: number, staleMs: number, blocked: Set<number>): CurveBuffer {
  const next: CurveBuffer = {}
  for (const r of registers) {
    const area = r.functionCode === 1 ? 'coil' : r.functionCode === 2 ? 'discrete-input' : r.functionCode === 4 ? 'input-register' : 'holding-register'
    const signature = `${area}:${r.startAddress}:${r.dataType}`
    const old = previous[r.id]?.signature === signature ? previous[r.id] : undefined
    const track: CurveTrack = { signature, times: old?.times ?? [], points: (old?.points ?? []).filter(p => p[0] >= now - 600_000) }
    const words = Array.from({ length: registerWidth(r.dataType) }, (_, i) => latest[`${objectId}:${area}:${r.startAddress + i}`])
    const times = words.map(sampleTime)
    const valid = !blocked.has(r.id) && words.every((s, i) => s && s.quality === 'good' && times[i] !== null && now - times[i]! <= staleMs && times[i]! <= now + 1000)
    if (!valid) {
      if (track.points.length && track.points.at(-1)![1] !== null) track.points.push([now, null])
    } else if (times.every((time, i) => time! > (track.times[i] ?? -Infinity))) {
      const decoded = decodeRegister(r.dataType, words.map(s => s.rawValue))
      // SVG numbers cannot represent large 64-bit integers exactly.
      const value = typeof decoded === 'bigint' && (decoded > BigInt(Number.MAX_SAFE_INTEGER) || decoded < BigInt(Number.MIN_SAFE_INTEGER)) ? NaN : Number(decoded)
      track.points.push([Math.max(...times as number[]), Number.isFinite(value) ? value : null])
      track.times = times as number[]
    }
    track.points = track.points.slice(-CURVE_LIMIT)
    next[r.id] = track
  }
  return next
}
