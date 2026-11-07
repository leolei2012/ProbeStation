import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'

export interface CommunicationScope { readonly objectId: number; readonly scope: 'device' | 'channel'; readonly channelKey: string }
export function communicationScope(device: { id: number; transport: string; serialPath?: string | null }): CommunicationScope {
  if (!Number.isSafeInteger(device.id) || device.id < 1 || !['tcp', 'rtu'].includes(device.transport) || device.transport === 'rtu' && device.serialPath != null && typeof device.serialPath !== 'string') throw new InvalidCommunicationSummary()
  return Object.freeze({ objectId: device.id, scope: device.transport === 'rtu' ? 'channel' : 'device', channelKey: device.transport === 'rtu' ? 'rtu:' + (device.serialPath ?? '') : 'tcp:' + device.id })
}
export class InvalidCommunicationSummary extends Error { constructor() { super('Invalid communication summary'); this.name = 'InvalidCommunicationSummary' } }
const record = (value: any) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidCommunicationSummary(); return value }
const count = (value: any): number => { if (!Number.isSafeInteger(value) || value < 0) throw new InvalidCommunicationSummary(); return value }
const duration = (value: any): number | null => { if (value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InvalidCommunicationSummary(); return value }
const timestamp = (value: any): string | null => { if (value === undefined) return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new InvalidCommunicationSummary(); return value }
export function parseCommunicationSummary(value: unknown, expected: CommunicationScope, receivedAt = new Date().toISOString()) {
  const root = record(value)
  if (root.objectId !== expected.objectId || root.scope !== expected.scope || root.channelKey !== expected.channelKey || typeof root.connected !== 'boolean') throw new InvalidCommunicationSummary()
  let metrics = null
  if (root.metrics !== null) {
    const raw = record(root.metrics)
    if (raw.scope !== expected.scope || raw.channelKey !== expected.channelKey || (expected.scope === 'device' ? raw.deviceId !== expected.objectId : raw.deviceId !== undefined)) throw new InvalidCommunicationSummary()
    const txFrames = count(raw.txFrames), rxFrames = count(raw.rxFrames), successCount = count(raw.successCount), errorCount = count(raw.errorCount), timeoutCount = count(raw.timeoutCount), consecutiveErrors = count(raw.consecutiveErrors), bufferedFrames = count(raw.bufferedFrames)
    if (!Number.isSafeInteger(successCount + errorCount) || timeoutCount > errorCount || consecutiveErrors > errorCount || typeof raw.recentErrorRate !== 'number' || !Number.isFinite(raw.recentErrorRate) || raw.recentErrorRate < 0 || raw.recentErrorRate > 1) throw new InvalidCommunicationSummary()
    let lastError = null
    if (raw.lastError !== undefined) {
      const error = record(raw.lastError)
      if (typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') throw new InvalidCommunicationSummary()
      lastError = Object.freeze({ code: error.code, message: error.message, retryable: error.retryable, exceptionCode: error.exceptionCode === undefined ? null : count(error.exceptionCode) })
    }
    metrics = Object.freeze({ txFrames, rxFrames, successCount, errorCount, timeoutCount, consecutiveErrors, bufferedFrames, recentErrorRate: raw.recentErrorRate as number, lastResponseMs: duration(raw.lastResponseMs), averageResponseMs: duration(raw.averageResponseMs), maxResponseMs: duration(raw.maxResponseMs), lastSuccessTime: timestamp(raw.lastSuccessTime), lastErrorTime: timestamp(raw.lastErrorTime), lastError })
  }
  return Object.freeze({ objectId: expected.objectId, scope: expected.scope, channelKey: expected.channelKey, connected: root.connected as boolean, receivedAt, metrics })
}
export type CommunicationSummaryValue = ReturnType<typeof parseCommunicationSummary>
export interface CommunicationReadState { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly value?: CommunicationSummaryValue; readonly error?: 'timeout' | 'invalid' | 'request' }
export class CommunicationSummaryRead {
  private state: CommunicationReadState = Object.freeze({ phase: 'idle' })
  private owner = new LatestConfigRead()
  private active?: symbol
  private listeners = new Set<() => void>()
  constructor(readonly scope: CommunicationScope) {}
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(state: CommunicationReadState) { this.state = Object.freeze(state); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel(); this.active = undefined; if (this.state.phase === 'loading') this.set({ ...this.state, phase: 'idle' }) }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
    if (this.active) return
    const active = Symbol(); this.active = active; this.set({ ...this.state, phase: 'loading', error: undefined })
    try {
      await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/monitor_objects/' + this.scope.objectId + '/diagnostics', inner), signal, timeoutMs).then(value => parseCommunicationSummary(value, this.scope)), value => this.set({ phase: 'ready', value }), error => this.set({ ...this.state, phase: 'error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidCommunicationSummary ? 'invalid' : 'request' }))
    } finally { if (this.active === active) this.active = undefined }
  }
}
