import { formatNumber, isBinType, isHexType } from '../../../packages/core/src/codec.ts'

export type ValueMode = 'raw' | 'physical'
export type DisplayRegister = { dataType: string; factor?: number | null; offset?: number | null; decimalPlaces?: number | null; unit?: string | null }
export function displayNumber(value: number | bigint, reg?: Pick<DisplayRegister, 'decimalPlaces'>): string {
  const digits = reg?.decimalPlaces
  if (digits == null || !Number.isInteger(digits) || digits < 0 || digits > 8) return formatNumber(value)
  if (typeof value === 'bigint') return value.toString() + (digits ? '.' + '0'.repeat(digits) : '')
  if (!Number.isFinite(value)) return formatNumber(value)
  const text = value.toFixed(digits)
  return Number(text) === 0 && text.startsWith('-') ? text.slice(1) : text
}
/** Full precision conversion for plotting. Display rounding never changes these numbers. */
export function curveValue(value: number | null, reg: DisplayRegister, mode: ValueMode): number | null {
  if (value === null || !Number.isFinite(value)) return null
  const next = mode === 'physical' ? value * (reg.factor ?? 1) + (reg.offset ?? 0) : value
  return Number.isFinite(next) ? next : null
}
export function physicalValue(raw: number | bigint, reg: DisplayRegister): { value: string | null; issue?: 'precision' | 'invalid' | 'raw' } {
  if (isHexType(reg.dataType) || isBinType(reg.dataType)) return { value: null, issue: 'raw' }
  const factor = reg.factor ?? 1, offset = reg.offset ?? 0
  if (!Number.isFinite(factor) || !Number.isFinite(offset)) return { value: null, issue: 'invalid' }
  if (typeof raw === 'bigint') {
    // Integer transformations preserve the full 64-bit value without converting to a double.
    if (Number.isSafeInteger(factor) && Number.isSafeInteger(offset)) return { value: displayNumber(raw * BigInt(factor) + BigInt(offset), reg) }
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) return { value: null, issue: 'precision' }
  }
  const result = Number(raw) * factor + offset
  return Number.isFinite(result) ? { value: displayNumber(result, reg) } : { value: null, issue: 'invalid' }
}
