import { ALARM_OPERATORS, type AlarmRule } from '../../../packages/core/src/alarm'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'

export const ALARM_RULE_READ_TIMEOUT_MS = 30_000
export class InvalidAlarmRulesError extends Error { constructor() { super('Invalid alarm rule response'); this.name = 'InvalidAlarmRulesError' } }
/** A partial/malformed list cannot prove that a rule is absent or that conditions are normal. */
export function parseAlarmRules(value: unknown): readonly AlarmRule[] {
  if (!Array.isArray(value)) throw new InvalidAlarmRulesError()
  const ids = new Set<number>()
  return Object.freeze(value.map(row => {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id) || !Number.isSafeInteger(row.registerId) || row.registerId < 1 || !ALARM_OPERATORS.includes(row.operator) || typeof row.threshold !== 'number' || !Number.isFinite(row.threshold) || row.message !== null && typeof row.message !== 'string') throw new InvalidAlarmRulesError()
    ids.add(row.id)
    return Object.freeze({ id: row.id, registerId: row.registerId, operator: row.operator, threshold: row.threshold, message: row.message })
  }))
}
export interface AlarmRuleReadState {
  readonly rules: readonly AlarmRule[]; readonly status: 'loading' | 'ready' | 'error'; readonly reading: boolean
  readonly updatedAt: number | null; readonly error: unknown
}
export function alarmRuleReadError(error: unknown): 'timeout' | 'invalid' | 'request' { return error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidAlarmRulesError ? 'invalid' : 'request' }
export function readAlarmRules(fetcher: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, timeoutMs = ALARM_RULE_READ_TIMEOUT_MS) {
  return runRequestWithTimeout(async childSignal => parseAlarmRules(await fetcher(childSignal)), signal, timeoutMs)
}
/** Per-hook, current-device read lifecycle. No request is started by construction/subscription. */
export class AlarmRulesReader {
  private state: AlarmRuleReadState = Object.freeze({ rules: Object.freeze([]), status: 'loading', reading: false, updatedAt: null, error: null })
  private listeners = new Set<() => void>()
  private generation = 0
  private active: AbortController | null = null
  constructor(private readonly fetcher: (signal: AbortSignal) => Promise<unknown>, private readonly timeoutMs = ALARM_RULE_READ_TIMEOUT_MS, private readonly now = Date.now) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: AlarmRuleReadState) { this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  /** Abort/settle only a read, never a write. Increment before abort to reject late callbacks. */
  stop = () => { ++this.generation; const previous = this.active; this.active = null; previous?.abort() }
  invalidate = () => { this.stop(); this.publish({ ...this.state, status: 'loading', reading: false, error: null }) }
  /** Readback after an explicit mutation passes through the same complete-list parser. */
  accept = (value: unknown) => { const rules = parseAlarmRules(value); this.stop(); this.publish({ rules, status: 'ready', reading: false, updatedAt: this.now(), error: null }) }
  refresh = async (force = false) => {
    if (this.active && !force) return // Poll ticks coalesce; they do not starve the deadline by restarting it.
    this.stop()
    const generation = this.generation, controller = new AbortController(); this.active = controller
    this.publish({ ...this.state, reading: true })
    try {
      const rules = await readAlarmRules(this.fetcher, controller.signal, this.timeoutMs)
      if (generation !== this.generation) return
      this.active = null; this.publish({ rules, status: 'ready', reading: false, updatedAt: this.now(), error: null })
    } catch (error) {
      if (generation !== this.generation) return
      this.active = null; this.publish({ ...this.state, status: 'error', reading: false, error })
    }
  }
}
