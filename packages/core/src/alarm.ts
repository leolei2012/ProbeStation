export const ALARM_OPERATORS = ['>', '>=', '==', '<=', '<', '!='] as const
export type AlarmOperator = typeof ALARM_OPERATORS[number]
export interface AlarmRule { id: number; registerId: number; operator: string; threshold: number; message: string | null }

/** Compare decoded raw values, preserving 64-bit integers. No scaling or display rounding. */
export function alarmMatches(value: number | bigint | null | undefined, operator: string, threshold: number): boolean {
  if (value == null || !Number.isFinite(threshold) || typeof value === 'number' && !Number.isFinite(value)) return false
  const equal = typeof value === 'bigint' ? Number.isInteger(threshold) && value === BigInt(threshold) : value === threshold
  switch (operator) {
    case '>': return value > threshold
    case '>=': return value >= threshold
    case '==': return equal
    case '<=': return value <= threshold
    case '<': return value < threshold
    case '!=': return !equal
    default: return false
  }
}
