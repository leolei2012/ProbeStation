import { isBinType, isHexType, registerWidth } from './codec.ts'

export interface HistoryCurvePoint { id: number; groupId: number; startAddress: number; dataType: string }
export interface HistoryCurveGroup { id: number; startAddress: number; quantity: number }
export type HistoryCurveExclusion = 'covered' | 'past-group-end' | 'non-numeric' | 'missing-group' | 'missing-point'
export interface HistoryCurveEntry { readonly id: number; readonly reason: 'eligible' | HistoryCurveExclusion; readonly coveredBy?: number }
export interface HistoryCurveSelectionPlan<T extends HistoryCurvePoint = HistoryCurvePoint> { readonly registers: readonly T[]; readonly entries: readonly HistoryCurveEntry[] }

/** Explain the existing curve selection policy. Coverage is evaluated before type/range/selection filters. */
export function planHistoryCurve<T extends HistoryCurvePoint>(groups: readonly HistoryCurveGroup[], points: readonly T[], selected: readonly number[] | null = null): HistoryCurveSelectionPlan<T> {
  const wanted = new Set(selected ?? points.map(p => p.id)), byGroup = new Map<number, T[]>(), reasons = new Map<number, HistoryCurveEntry>(), registers: T[] = []
  for (const id of wanted) reasons.set(id, { id, reason: 'missing-point' })
  for (const p of points) {
    const list = byGroup.get(p.groupId) ?? []; list.push(p); byGroup.set(p.groupId, list)
    if (wanted.has(p.id)) reasons.set(p.id, { id: p.id, reason: 'missing-group' })
  }
  for (const group of groups) {
    let covered = -1, coveredBy: number | undefined
    for (const point of [...(byGroup.get(group.id) ?? [])].sort((a, b) => a.startAddress - b.startAddress)) {
      let reason: HistoryCurveEntry['reason'] = 'eligible', blocker: number | undefined
      if (point.startAddress < covered) { reason = 'covered'; blocker = coveredBy }
      else {
        covered = point.startAddress + registerWidth(point.dataType); coveredBy = point.id
        // Preserve the original <= check: an unordered/NaN boundary must not be accepted.
        if (!(covered <= group.startAddress + group.quantity)) reason = 'past-group-end'
        else if (isHexType(point.dataType) || isBinType(point.dataType)) reason = 'non-numeric'
      }
      if (!wanted.has(point.id)) continue
      reasons.set(point.id, { id: point.id, reason, ...(blocker === undefined ? {} : { coveredBy: blocker }) })
      if (reason === 'eligible') registers.push(point)
    }
  }
  return Object.freeze({ registers: Object.freeze(registers), entries: Object.freeze([...wanted].sort((a, b) => a - b).map(id => Object.freeze(reasons.get(id)!))) })
}
