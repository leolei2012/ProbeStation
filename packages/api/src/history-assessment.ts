import { decodeHistoricalSample } from '../../core/src/history-integrity.ts'

/** Automated consumers receive numeric values only when identity and quality are verified. */
export function assistantHistoryPoints(reg: { startAddress: number; dataType: string; slaveId?: number; sourceAmbiguous?: boolean }, rows: any[], base: any[]) {
  const byTime = new Map<number, any[]>()
  for (const row of rows) {
    if (!Number.isFinite(row.timestampMs)) continue
    if (!byTime.has(row.timestampMs)) byTime.set(row.timestampMs, [])
    byTime.get(row.timestampMs)!.push(row)
  }
  // If a timestamp contains both attributed and legacy rows, report only the selected
  // source's base row. Never relabel a NULL base row with another row's verified value.
  const selected = base.filter(p => {
    if (reg.slaveId === undefined) return true
    const attributed = (byTime.get(p.timestampMs) ?? []).some(row => row.address === reg.startAddress && row.slaveId === reg.slaveId)
    return attributed ? p.slaveId === reg.slaveId : p.slaveId == null
  })
  return selected.map(p => {
    const result = decodeHistoricalSample(reg, byTime.get(p.timestampMs) ?? [])
    return { ts: p.ts, timestampMs: p.timestampMs, batchId: p.batchId ?? null, slaveId: p.slaveId ?? null, quality: p.quality, value: result.automaticEligible ? result.value : null, compatibilityValue: result.verification === 'unverified' ? result.value : null, verification: result.verification, automaticEligible: result.automaticEligible, reason: result.reason }
  })
}
