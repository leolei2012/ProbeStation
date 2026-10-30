import { decodeHistoricalSample, type HistoryVerification } from '../../../packages/core/src/history-integrity.ts'
import { isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec.ts'

export interface HistoryPoint { ts: string; area: string; address: number; rawValue: number; quality?: string; batchId?: string | null; timestampMs?: number }
export interface HistoryRegister { id: number; groupId: number; startAddress: number; dataType: string; functionCode: number }
export type HistorySample = [number, number | null]
/** Use Date's millisecond precision for both viewport identity and serialized requests. */
export function historyQueryRange(range: { start: number; end: number }) {
  return { start: new Date(range.start).getTime(), end: new Date(range.end).getTime() }
}
export interface HistorySeries {
  id: number; samples: HistorySample[]; gapMs: number
  verification?: Array<[number, HistoryVerification]>
  segments?: Array<[number, number]>
  sourceGapMs?: number | null
  integrity?: { verified: number; unverified: number; unknown: number }
  summary?: { sourceSamples: number; validSamples: number; invalidSamples: number }
}

/** Segment IDs are assigned before downsampling; retained-point spacing is not acquisition spacing. */
export function historyLineStarts(samples: readonly HistorySample[], gapMs: number, segments?: ReadonlyArray<readonly [number, number]>): Set<number> {
  const byTime = new Map(segments ?? [])
  const starts = new Set<number>()
  let previous: number | null = null, previousSegment: number | undefined
  for (const [index, [time, value]] of samples.entries()) {
    if (value === null || !Number.isFinite(value)) { previous = null; previousSegment = undefined; continue }
    const segment = byTime.get(time)
    const explicit = segment !== undefined && previousSegment !== undefined
    if (previous === null || (explicit ? segment !== previousSegment : time - previous > gapMs)) starts.add(index)
    previous = time; previousSegment = segment
  }
  return starts
}

/** Last means the final observed sample, including a failed/invalid reading. */
export function historySampleStats(samples: HistorySample[]) {
  let min = Infinity, max = -Infinity
  for (const [, value] of samples) if (value !== null && Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value) }
  const last = samples.at(-1)?.[1] ?? null
  return { min, max, last: last !== null && Number.isFinite(last) ? last : null }
}

export function decodeHistorySeries(registers: HistoryRegister[], points: HistoryPoint[], selected: Set<number>): HistorySeries[] {
  const buckets = new Map<number, HistoryPoint[]>()
  for (const p of points) {
    const time = p.timestampMs ?? Date.parse(p.ts)
    if (!Number.isFinite(time)) continue
    if (!buckets.has(time)) buckets.set(time, [])
    buckets.get(time)!.push(p)
  }
  return registers.filter(r => selected.has(r.id) && !isHexType(r.dataType) && !isBinType(r.dataType)).map(r => {
    const area = r.functionCode === 1 ? 'coil' : r.functionCode === 2 ? 'discrete-input' : r.functionCode === 4 ? 'input-register' : 'holding-register'
    const samples: HistorySample[] = [], verification: Array<[number, HistoryVerification]> = []
    const integrity = { verified: 0, unverified: 0, unknown: 0 }
    for (const [time, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
      const relevant = rows.filter(p => p.area === area && p.address >= r.startAddress && p.address < r.startAddress + registerWidth(r.dataType))
      if (!relevant.length) continue
      const decoded = decodeHistoricalSample(r, relevant), v = decoded.value
      const n = v == null || (typeof v === 'bigint' && (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))) ? NaN : Number(v)
      const state = Number.isFinite(n) ? decoded.verification : 'unknown'
      samples.push([time, Number.isFinite(n) ? n : null]); verification.push([time, state]); integrity[state]++
    }
    const intervals = samples.slice(1).map((p, i) => p[0] - samples[i][0]).filter(v => v > 0).sort((a, b) => a - b)
    return { id: r.id, samples, verification, integrity, gapMs: intervals.length ? intervals[Math.floor(intervals.length / 2)] * 3 : Infinity }
  }).filter(s => s.samples.length > 0)
}

/** Return the actual nearest sample, not an interpolated value. */
export function nearestHistorySample(samples: HistorySample[], time: number): HistorySample | undefined {
  if (!samples.length) return undefined
  let lo = 0, hi = samples.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid][0] < time) lo = mid + 1; else hi = mid }
  if (lo === 0) return samples[0]
  if (lo === samples.length) return samples.at(-1)
  return time - samples[lo - 1][0] <= samples[lo][0] - time ? samples[lo - 1] : samples[lo]
}
