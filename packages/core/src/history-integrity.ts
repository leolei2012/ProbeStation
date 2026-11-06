import { decodeRegister, registerWidth } from './codec.ts'
import { validSlaveId } from './sample-source.ts'

export type HistoryVerification = 'verified' | 'unverified' | 'unknown'
export interface HistoryWord { address: number; rawValue: number; quality?: string; batchId?: string | null; slaveId?: number | null }
export const historyVerificationLabel = { verified: '批次/来源已验证', unverified: '批次/来源未验证', unknown: '未知' } as const

/** Call only with one device, area and exact timestamp. No cache fill or timestamp tolerance. */
export function decodeHistoricalSample(reg: { startAddress: number; dataType: string; slaveId?: number; sourceAmbiguous?: boolean }, points: HistoryWord[]) {
  const width = registerWidth(reg.dataType)
  const candidates = points.filter(p => p.address >= reg.startAddress && p.address < reg.startAddress + width)
  const targetKnown = validSlaveId(reg.slaveId), matching = targetKnown ? candidates.filter(p => p.slaveId === reg.slaveId) : []
  const rows = (targetKnown ? matching.length ? matching : candidates.filter(p => p.slaveId == null) : candidates).sort((a, b) => a.address - b.address)
  const words = rows.map(p => p.rawValue)
  const unknown = (reason: string) => ({ value: null, words, verification: 'unknown' as const, automaticEligible: false, reason })
  if (candidates.some(p => p.slaveId != null && !validSlaveId(p.slaveId))) return unknown('invalid-source')
  if (!matching.length && reg.sourceAmbiguous && rows.some(p => p.slaveId == null)) return unknown('ambiguous-legacy-source')
  if (new Set(rows.map(p => p.slaveId ?? null)).size > 1) return unknown('mixed-sources')
  if (rows.length !== width || new Set(rows.map(p => p.address)).size !== width) return unknown('missing-or-duplicate-words')
  if (rows.some(p => !Number.isInteger(p.rawValue) || p.rawValue < 0 || p.rawValue > 65535 || (p.quality !== undefined && p.quality !== 'good'))) return unknown('invalid-word-or-quality')
  const ids = rows.map(p => typeof p.batchId === 'string' && p.batchId.length ? p.batchId : null)
  const legacy = ids.every(id => id === null)
  if (!legacy && (ids.some(id => id !== ids[0]) || rows.some(p => p.quality !== 'good'))) return unknown('mixed-or-incomplete-response')
  const value = decodeRegister(reg.dataType, words)
  if (typeof value === 'number' && !Number.isFinite(value)) return unknown('nonfinite-value')
  const sourceVerified = targetKnown && rows.every(p => p.slaveId === reg.slaveId)
  return { value, words, verification: legacy || !sourceVerified ? 'unverified' as const : 'verified' as const, automaticEligible: !legacy && sourceVerified, reason: !sourceVerified ? 'source-identity-unavailable' : legacy ? 'response-identity-unavailable' : 'complete-response' }
}

/** Cached words must also share an exact valid sampling time before applying the history policy. */
export function decodeLatestSample(reg: Parameters<typeof decodeHistoricalSample>[0], points: Array<HistoryWord & { timestamp?: string; timestampMs?: number }>) {
  const times = points.map(p => p.timestampMs ?? Date.parse(p.timestamp ?? ''))
  if (times.some(t => !Number.isFinite(t)) || new Set(times).size !== 1) return { ...decodeHistoricalSample(reg, []), reason: 'missing-or-mixed-sample-times' }
  return decodeHistoricalSample(reg, points)
}
