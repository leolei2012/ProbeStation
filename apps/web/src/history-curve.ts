import { decodeRawByAddr, isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec.ts'

export interface HistoryPoint { ts: string; area: string; address: number; rawValue: number }
export interface HistoryRegister { id: number; groupId: number; startAddress: number; dataType: string; functionCode: number }
export type HistorySample = [number, number | null]
export interface HistorySeries { id: number; samples: HistorySample[]; gapMs: number }

export function decodeHistorySeries(registers: HistoryRegister[], points: HistoryPoint[], selected: Set<number>): HistorySeries[] {
  const buckets = new Map<number, Map<string, Record<number, number>>>()
  for (const p of points) {
    const time = Date.parse(p.ts)
    if (!Number.isFinite(time)) continue
    if (!buckets.has(time)) buckets.set(time, new Map())
    const areas = buckets.get(time)!
    if (!areas.has(p.area)) areas.set(p.area, {})
    areas.get(p.area)![p.address] = p.rawValue
  }
  const result = new Map<number, HistorySample[]>()
  const groups = new Map<number, HistoryRegister[]>()
  for (const r of registers) { if (!groups.has(r.groupId)) groups.set(r.groupId, []); groups.get(r.groupId)!.push(r) }
  for (const [time, areas] of [...buckets].sort((a, b) => a[0] - b[0])) {
    for (const regs of groups.values()) {
      const fc = regs[0].functionCode
      const area = fc === 1 ? 'coil' : fc === 2 ? 'discrete-input' : fc === 4 ? 'input-register' : 'holding-register'
      const words = areas.get(area)
      if (!words) continue
      const decoded = decodeRawByAddr(regs, words)
      for (const r of regs) {
        if (!selected.has(r.id) || isHexType(r.dataType) || isBinType(r.dataType)) continue
        if (!Array.from({ length: registerWidth(r.dataType) }, (_, i) => words[r.startAddress + i]).some(v => v !== undefined)) continue
        const v = decoded.get(r.id)
        const n = v == null || (typeof v === 'bigint' && (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))) ? NaN : Number(v)
        if (!result.has(r.id)) result.set(r.id, [])
        result.get(r.id)!.push([time, Number.isFinite(n) ? n : null])
      }
    }
  }
  return [...result].map(([id, samples]) => {
    const intervals = samples.slice(1).map((p, i) => p[0] - samples[i][0]).filter(v => v > 0).sort((a, b) => a - b)
    return { id, samples, gapMs: intervals.length ? intervals[Math.floor(intervals.length / 2)] * 3 : Infinity }
  }).filter(s => s.samples.some(p => p[1] !== null))
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
