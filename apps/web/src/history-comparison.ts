import { historyLineStarts, nearestHistorySample, type HistorySeries } from './history-curve'
import type { HistoryVerification } from '../../../packages/core/src/history-integrity'

export interface AnchorReading { readonly id: number; readonly time: number | null; readonly value: number | null; readonly verification: HistoryVerification }
export interface HistoryAnchor { readonly time: number; readonly readings: readonly AnchorReading[] }
export interface HistoryComparisonState { context: string; a: HistoryAnchor | null; b: HistoryAnchor | null }
export type HistoryComparisonAction = { type: 'context'; context: string } | { type: 'clear'; context: string } | { type: 'capture'; context: string; slot: 'a' | 'b'; anchor: HistoryAnchor }
export function updateHistoryComparison(state: HistoryComparisonState, action: HistoryComparisonAction): HistoryComparisonState {
  const base = state.context === action.context ? state : { context: action.context, a: null, b: null }
  if (action.type === 'context') return base
  if (action.type === 'clear') return { context: action.context, a: null, b: null }
  return { ...base, [action.slot]: action.anchor }
}

/** Select an actual displayed sample; never interpolate, extrapolate or bridge a broken line. */
export function captureHistoryAnchor(time: number, series: readonly HistorySeries[]): HistoryAnchor {
  const cursor = new Date(time).getTime()
  if (!Number.isFinite(cursor)) throw new Error('Invalid comparison time')
  const readings = new Map<number, AnchorReading>()
  for (const source of series) {
    let reading: AnchorReading = { id: source.id, time: null, value: null, verification: 'unknown' }
    const samples = source.samples
    const ordered = samples.every((sample, i) => Number.isFinite(sample[0]) && (i === 0 || sample[0] > samples[i - 1][0]))
    if (!readings.has(source.id) && ordered && samples.length && cursor >= samples[0][0] && cursor <= samples.at(-1)![0]) {
      const exact = samples.findIndex(sample => sample[0] === cursor)
      const right = exact < 0 ? samples.findIndex(sample => sample[0] > cursor) : exact
      const segments = new Map(source.segments ?? [])
      const states = new Map(source.verification ?? [])
      const verificationAt = (time: number): HistoryVerification => {
        const state = states.get(time) ?? 'unverified'
        return state === 'verified' || state === 'unverified' ? state : 'unknown'
      }
      const usable = (index: number) => samples[index][1] !== null && Number.isFinite(samples[index][1]) && verificationAt(samples[index][0]) !== 'unknown'
      const explicit = right > 0 && segments.has(samples[right - 1][0]) && segments.has(samples[right][0])
      const connected = exact >= 0 || right > 0 && usable(right - 1) && usable(right) && (explicit || Number.isFinite(source.gapMs)) && !historyLineStarts(samples, source.gapMs, source.segments).has(right)
      if (connected) {
        const sample = nearestHistorySample(samples, cursor)!
        const verification = verificationAt(sample[0])
        const value = sample[1] !== null && Number.isFinite(sample[1]) && verification !== 'unknown' ? sample[1] : null
        reading = { id: source.id, time: sample[0], value, verification: value === null ? 'unknown' : verification }
      }
    }
    readings.set(source.id, Object.freeze(reading))
  }
  return Object.freeze({ time: cursor, readings: Object.freeze([...readings.values()]) })
}

export function compareHistoryAnchors(a: HistoryAnchor | null, b: HistoryAnchor | null) {
  const left = new Map(a?.readings.map(reading => [reading.id, reading]) ?? []), right = new Map(b?.readings.map(reading => [reading.id, reading]) ?? [])
  return [...new Set([...left.keys(), ...right.keys()])].sort((x, y) => x - y).map(id => {
    const atA = left.get(id), atB = right.get(id)
    const difference = atA?.value != null && atB?.value != null && atA.verification !== 'unknown' && atB.verification !== 'unknown' ? atB.value - atA.value : null
    const elapsed = atA?.time != null && atB?.time != null ? atB.time - atA.time : null
    return { id, a: atA, b: atB, difference: difference !== null && Number.isFinite(difference) ? difference : null, elapsed: elapsed !== null && Number.isSafeInteger(elapsed) ? elapsed : null }
  })
}

interface ComparisonPoint { id: number; alias: string | null; dataType: string; functionCode: number; startAddress: number; slaveId?: number; sourceAmbiguous?: boolean; factor?: number; offset?: number; unit?: string | null; decimalPlaces?: number | null }
/** Query-detail/zoom updates keep frozen anchors; a changed definition or display meaning clears them. */
export function historyComparisonContext(points: readonly ComparisonPoint[], range: { start: number; end: number }, mode: string, hidden: ReadonlySet<number>): string {
  return JSON.stringify([range.start, range.end, mode, [...hidden].sort((a, b) => a - b), [...points].sort((a, b) => a.id - b.id).map(p => [p.id, p.alias, p.dataType, p.functionCode, p.startAddress, p.slaveId ?? null, !!p.sourceAmbiguous, p.factor ?? 1, p.offset ?? 0, p.unit ?? null, p.decimalPlaces ?? null])])
}
