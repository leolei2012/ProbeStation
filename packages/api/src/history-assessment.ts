import { decodeHistoricalSample } from '../../core/src/history-integrity.ts'

/** Automated consumers receive numeric values only when identity and quality are verified. */
export function assistantHistoryPoints(reg: { startAddress: number; dataType: string }, rows: any[], base: any[]) {
  const byTime = new Map<number, any[]>()
  for (const row of rows) {
    if (!Number.isFinite(row.timestampMs)) continue
    if (!byTime.has(row.timestampMs)) byTime.set(row.timestampMs, [])
    byTime.get(row.timestampMs)!.push(row)
  }
  return base.map(p => {
    const result = decodeHistoricalSample(reg, byTime.get(p.timestampMs) ?? [])
    return { ts: p.ts, timestampMs: p.timestampMs, batchId: p.batchId ?? null, quality: p.quality, value: result.automaticEligible ? result.value : null, compatibilityValue: result.verification === 'unverified' ? result.value : null, verification: result.verification, automaticEligible: result.automaticEligible, reason: result.reason }
  })
}
