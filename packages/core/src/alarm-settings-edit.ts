import { ALARM_OPERATORS, type AlarmRule } from './alarm.ts'
import { parseAlarmContext, type AlarmContext } from './alarm-settings-context.ts'
export type AlarmRuleChanges = Partial<Pick<AlarmRule, 'operator' | 'threshold' | 'message'>>
export const invalidAlarmEdit = (): never => { throw Object.assign(new Error('告警编辑参数无效，请重新读取规则。'), { statusCode: 400 }) }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidAlarmEdit(); return value as Record<string, unknown> }
export function captureAlarmRule(value: unknown): Readonly<AlarmRule> {
  const row = object(value)
  if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 || !Number.isSafeInteger(row.registerId) || (row.registerId as number) < 1 || !(ALARM_OPERATORS as readonly unknown[]).includes(row.operator) || typeof row.threshold !== 'number' || !Number.isFinite(row.threshold) || row.message !== null && typeof row.message !== 'string') return invalidAlarmEdit()
  return Object.freeze({ id: row.id as number, registerId: row.registerId as number, operator: row.operator as string, threshold: row.threshold, message: row.message as string | null })
}
export function alarmRuleMatches(current: AlarmRule, expected: AlarmRule) {
  return (['id', 'registerId', 'operator', 'threshold', 'message'] as const).every(key => current[key] === expected[key])
}
export function parseAlarmEdit(value: unknown, deleting = false): { expected: Readonly<AlarmRule>; changes: Readonly<AlarmRuleChanges>; expectedContext?: AlarmContext } {
  const body = object(value)
  if (Object.keys(body).some(key => !(deleting ? ['expected', 'expectedContext'] : ['expected', 'changes', 'expectedContext']).includes(key))) return invalidAlarmEdit()
  const expected = captureAlarmRule(body.expected), changes = deleting ? {} : object(body.changes)
  if (!deleting && !Object.keys(changes).length) return invalidAlarmEdit()
  for (const [key, entry] of Object.entries(changes)) {
    if (key === 'operator' ? !(ALARM_OPERATORS as readonly unknown[]).includes(entry) : key === 'threshold' ? typeof entry !== 'number' || !Number.isFinite(entry) : key === 'message' ? entry !== null && (typeof entry !== 'string' || entry.length > 200) : true) return invalidAlarmEdit()
  }
  const expectedContext = Object.hasOwn(body, 'expectedContext') ? parseAlarmContext(body.expectedContext) : undefined
  if (expectedContext && expectedContext.point.id !== expected.registerId) return invalidAlarmEdit()
  return { expected, changes: Object.freeze({ ...changes }), ...(expectedContext ? { expectedContext } : {}) }
}
