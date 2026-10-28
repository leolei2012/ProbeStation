import { decodeRegister, registerWidth } from './codec.ts'

export type HistoryVerification = 'verified' | 'unverified' | 'unknown'
export interface HistoryWord { address: number; rawValue: number; quality?: string; batchId?: string | null }
export const historyVerificationLabel = { verified: '批次已验证', unverified: '批次未验证', unknown: '未知' } as const

/** Call only with one device, area and exact timestamp. No cache fill or timestamp tolerance. */
export function decodeHistoricalSample(reg: { startAddress: number; dataType: string }, points: HistoryWord[]) {
  const width = registerWidth(reg.dataType)
  const rows = points.filter(p => p.address >= reg.startAddress && p.address < reg.startAddress + width).sort((a, b) => a.address - b.address)
  const words = rows.map(p => p.rawValue)
  const unknown = (reason: string) => ({ value: null, words, verification: 'unknown' as const, automaticEligible: false, reason })
  if (rows.length !== width || new Set(rows.map(p => p.address)).size !== width) return unknown('missing-or-duplicate-words')
  if (rows.some(p => !Number.isInteger(p.rawValue) || p.rawValue < 0 || p.rawValue > 65535 || (p.quality !== undefined && p.quality !== 'good'))) return unknown('invalid-word-or-quality')
  const ids = rows.map(p => typeof p.batchId === 'string' && p.batchId.length ? p.batchId : null)
  const legacy = ids.every(id => id === null)
  if (!legacy && (ids.some(id => id !== ids[0]) || rows.some(p => p.quality !== 'good'))) return unknown('mixed-or-incomplete-response')
  const value = decodeRegister(reg.dataType, words)
  if (typeof value === 'number' && !Number.isFinite(value)) return unknown('nonfinite-value')
  return { value, words, verification: legacy ? 'unverified' as const : 'verified' as const, automaticEligible: !legacy, reason: legacy ? 'response-identity-unavailable' : 'complete-response' }
}
