import { alarmRuleMatches, captureAlarmRule, parseAlarmEdit, type AlarmRuleChanges } from '../../../packages/core/src/alarm-settings-edit'
import type { AlarmRule } from '../../../packages/core/src/alarm'
import { runRequestWithTimeout } from './request-timeout'
import { readAlarmRules } from './alarm-rule-read'
import { captureAlarmContext, parseAlarmContext, alarmContextMatches, type AlarmContext } from '../../../packages/core/src/alarm-settings-context'

export async function createAlarm(fields: Pick<AlarmRule, 'registerId' | 'operator' | 'threshold' | 'message'>, send: (url: string, method: string, body: unknown) => Promise<unknown>, context?: AlarmContext): Promise<readonly string[]> {
  const input = captureAlarmRule({ id: 1, ...fields })
  parseAlarmEdit({ expected: input, changes: { operator: input.operator, threshold: input.threshold, message: input.message } })
  const { id: _validationId, ...body } = input
  const expectedContext = context === undefined ? undefined : parseAlarmContext(context)
  if (expectedContext && expectedContext.point.id !== body.registerId) throw Object.assign(new Error('告警点位与来源条件不一致。'), { statusCode: 400 })
  const result = await send(expectedContext ? '/api/rules/settings' : '/api/rules', 'POST', expectedContext ? { fields: body, expectedContext } : body) as any
  try {
    if (expectedContext && (result?.protection !== 'rule-and-context' || !Array.isArray(result.warnings) || result.warnings.some((v: unknown) => typeof v !== 'string'))) throw new Error('unverified protection')
    const saved = captureAlarmRule(expectedContext ? result.rule : result)
    if (!alarmRuleMatches(saved, { id: saved.id, ...body })) throw new Error('mismatched saved rule')
  } catch { throw new Error('新增告警结果待核实，请重新读取核对，勿重复新增。') }
  return Object.freeze(expectedContext ? [...result.warnings] as string[] : [])
}
export async function writeGuardedAlarm(expected: Readonly<AlarmRule>, changes: AlarmRuleChanges | null, send: (url: string, method: string, body: unknown) => Promise<unknown>, context?: AlarmContext): Promise<readonly string[]> {
  const request = parseAlarmEdit({ expected, ...(changes === null ? {} : { changes }), ...(context === undefined ? {} : { expectedContext: context }) }, changes === null)
  const result = await send('/api/rules/' + expected.id + '/settings', changes === null ? 'DELETE' : 'PUT', changes === null ? { expected: request.expected, ...(request.expectedContext ? { expectedContext: request.expectedContext } : {}) } : request) as any
  const uncertain = () => new Error('告警操作结果待核实，请重新读取核对，勿重复操作。')
  if (!result || !Array.isArray(result.warnings) || result.warnings.some((value: unknown) => typeof value !== 'string')) throw uncertain()
  if (request.expectedContext && result.protection !== 'rule-and-context') throw uncertain()
  if (changes === null) { if (result.rule !== null || result.deletedRuleId !== expected.id) throw uncertain() }
  else {
    let rule: AlarmRule
    try { rule = captureAlarmRule(result.rule) } catch { throw uncertain() }
    if (result.deletedRuleId !== null || !alarmRuleMatches(rule, { ...request.expected, ...request.changes })) throw uncertain()
  }
  return Object.freeze([...result.warnings])
}
export function captureAlarmOpening(point: any, groups: readonly { id: number; registers: readonly any[] }[], device: unknown): AlarmContext {
  const group = groups.find(g => g.id === point?.groupId && g.registers.some(p => p.id === point?.id))
  return captureAlarmContext(point, group, device)
}
export function alarmOpeningState(opening: AlarmContext | null, groups: readonly { id: number; registers: readonly any[] }[], device: unknown): 'ready' | 'changed' | 'unavailable' {
  if (!opening) return 'unavailable'
  const group = groups.find(g => g.id === opening.point.groupId), point = group?.registers.find(p => p.id === opening.point.id)
  if (!point) return 'unavailable'
  try { return alarmContextMatches(opening, captureAlarmContext(point, group, device)) ? 'ready' : 'changed' } catch { return 'unavailable' }
}
/** Readback failure follows a successful write, so even an HTTP 4xx here is an uncertain outcome. */
export async function completeAlarmWrite(action: (signal: AbortSignal) => Promise<readonly string[]>, read: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) {
  const warnings = await action(signal)
  try { return { rules: await readAlarmRules(read, signal), warnings } }
  catch { throw new Error('告警操作已返回，但规则读回待核实；勿直接重复操作。') }
}
export type AlarmWriteState = Readonly<{ phase: 'idle' | 'writing' | 'saved' | 'blocked'; reason: 'conflict' | 'rejected' | 'uncertain' | null; detail: string }>
/** A refresh never unblocks an uncertain write. Only an explicit draft reset can start another operation. */
export class AlarmWriteGate {
  private state: AlarmWriteState = Object.freeze({ phase: 'idle', reason: null, detail: '' })
  private listeners = new Set<() => void>()
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(state: AlarmWriteState) { this.state = Object.freeze(state); this.listeners.forEach(fn => fn()) }
  reset() { if (this.state.phase !== 'writing') this.set({ phase: 'idle', reason: null, detail: '' }) }
  async run(action: (signal: AbortSignal) => Promise<void>, timeoutMs = 30000): Promise<boolean> {
    if (this.state.phase !== 'idle') return false
    this.set({ phase: 'writing', reason: null, detail: '' })
    try { await runRequestWithTimeout(action, new AbortController().signal, timeoutMs); this.set({ phase: 'saved', reason: null, detail: '' }); return true }
    catch (error: any) {
      const reason = error?.statusCode === 409 ? 'conflict' : [400, 404].includes(error?.statusCode) ? 'rejected' : 'uncertain'
      this.set({ phase: 'blocked', reason, detail: reason === 'uncertain' ? '' : error instanceof Error ? error.message : '' }); return false
    }
  }
}
