import { sourceSample } from '../../../packages/core/src/sample-source.ts'
import { decodeRegister, registerWidth } from '../../../packages/core/src/codec.ts'
import { sampleTime, type Sample } from './observation'
import { sameResponseBatch } from '../../../packages/core/src/sample-batch.ts'

export interface CurveRegister { id: number; startAddress: number; dataType: string; functionCode: number; slaveId?: number }
export interface CurveTrack { signature: string; times: number[]; points: Array<[number, number | null]>; batchId?: string | null }
export type CurveBuffer = Record<number, CurveTrack>
export const CURVE_LIMIT = 2400

/** Connected runs collapsed to one coordinate need a marker, including repeated identical points. */
export function isolatedCurvePoints(points: ReadonlyArray<readonly [number, number | null]>, gapMs: number): Array<[number, number]> {
  const isolated: Array<[number, number]> = []
  let first: [number, number] | null = null, lastTime = 0, hasExtent = false
  const finish = () => { if (first && !hasExtent) isolated.push(first); first = null; hasExtent = false }
  for (const [time, value] of points) {
    if (value === null) { finish(); continue }
    if (first === null || time - lastTime > gapMs) { finish(); first = [time, value] }
    else if (time !== first[0] || value !== first[1]) hasExtent = true
    lastTime = time
  }
  finish()
  return isolated
}

function curveSignature(r: CurveRegister, objectId: number): string {
  return JSON.stringify([objectId, r.functionCode, r.startAddress, r.dataType, r.slaveId ?? null])
}

/** Frozen/published frames must still match the current logical point source and decoder. */
export function curveTrackFor(buffer: CurveBuffer, r: CurveRegister, objectId: number): CurveTrack | undefined {
  const track = buffer[r.id]
  return track?.signature === curveSignature(r, objectId) ? track : undefined
}

/** Bounded display sampling; never repeat an unchanged snapshot or join partial multiword updates. */
export function sampleCurve(previous: CurveBuffer, registers: CurveRegister[], latest: Record<string, Sample>, objectId: number, now: number, staleMs: number, blocked: Set<number>): CurveBuffer {
  const next: CurveBuffer = {}
  for (const r of registers) {
    const area = r.functionCode === 1 ? 'coil' : r.functionCode === 2 ? 'discrete-input' : r.functionCode === 4 ? 'input-register' : 'holding-register'
    const signature = curveSignature(r, objectId)
    const old = curveTrackFor(previous, r, objectId)
    const track: CurveTrack = { signature, times: old?.times ?? [], batchId: old?.batchId, points: (old?.points ?? []).filter(p => p[0] >= now - 600_000) }
    const words = Array.from({ length: registerWidth(r.dataType) }, (_, i) => sourceSample(latest, objectId, area, r.startAddress + i, r.slaveId))
    const times = words.map(sampleTime)
    const valid = !blocked.has(r.id) && sameResponseBatch(words) && words.every((s, i) => s && s.quality === 'good' && times[i] !== null && now - times[i]! <= staleMs && times[i]! <= now + 1000)
    const batchId = words[0]?.batchId
    if (!valid) {
      if (track.points.length && track.points.at(-1)![1] !== null) track.points.push([now, null])
    } else if (batchId ? batchId !== track.batchId && times.every((time, i) => time! >= (track.times[i] ?? -Infinity)) : times.every((time, i) => time! > (track.times[i] ?? -Infinity))) {
      const decoded = decodeRegister(r.dataType, words.map(s => s!.rawValue))
      // SVG numbers cannot represent large 64-bit integers exactly.
      const value = typeof decoded === 'bigint' && (decoded > BigInt(Number.MAX_SAFE_INTEGER) || decoded < BigInt(Number.MIN_SAFE_INTEGER)) ? NaN : Number(decoded)
      track.points.push([Math.max(...times as number[]), Number.isFinite(value) ? value : null])
      track.times = times as number[]
      track.batchId = batchId
    }
    track.points = track.points.slice(-CURVE_LIMIT)
    next[r.id] = track
  }
  return next
}
