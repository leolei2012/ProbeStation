import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'
export interface RetentionApi { get: (url: string, signal: AbortSignal) => Promise<unknown>; post: (url: string, body: unknown) => Promise<unknown> }
export interface GlobalRetentionState { readonly phase: 'idle' | 'reading' | 'ready' | 'read-error' | 'saving'; readonly seconds: number | null; readonly outcome: 'none' | 'confirmed' | 'uncertain'; readonly requested?: number; readonly checkedAt?: string; readonly error?: 'timeout' | 'invalid' | 'request'; readonly slow?: boolean }
const seconds = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export function retentionDraftValue(text: string): number | null { if (typeof text !== 'string' || !text.trim()) return null; const value = Number(text); return seconds(value) ? value : null }
class InvalidRetention extends Error {}
export class GlobalRetentionFlow {
  private state: GlobalRetentionState = Object.freeze({ phase: 'idle', seconds: null, outcome: 'none' })
  private owner = new LatestConfigRead()
  private write?: symbol
  private listeners = new Set<() => void>()
  constructor(private readonly options: { readTimeoutMs?: number; slowWriteMs?: number } = {}) {}
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(value: GlobalRetentionState) { this.state = Object.freeze(value); this.listeners.forEach(fn => fn()) }
  closeRead() { this.owner.cancel(); if (this.state.phase === 'reading') this.set({ ...this.state, phase: 'idle' }) }
  async read(api: RetentionApi) {
    if (this.write || this.state.phase === 'reading') return
    this.set({ ...this.state, phase: 'reading', error: undefined })
    await this.owner.run(signal => runRequestWithTimeout(async inner => { const value = await api.get('/api/retention', inner) as any; if (!value || !seconds(value.retention_seconds)) throw new InvalidRetention(); return value.retention_seconds as number }, signal, this.options.readTimeoutMs ?? 10000), value => this.set({ ...this.state, phase: 'ready', seconds: value, checkedAt: new Date().toISOString(), error: undefined }), error => this.set({ ...this.state, phase: 'read-error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidRetention ? 'invalid' : 'request' }))
  }
  async apply(text: string, acknowledged: boolean, api: RetentionApi) {
    const value = retentionDraftValue(text)
    if (this.write || !acknowledged || this.state.phase !== 'ready' || this.state.outcome === 'uncertain' || this.state.seconds === null || value === null || value === this.state.seconds) return
    const operation = this.write = Symbol(); this.owner.cancel()
    this.set({ ...this.state, phase: 'saving', outcome: 'none', requested: value, error: undefined, slow: false })
    const timer = setTimeout(() => { if (this.write === operation) this.set({ ...this.state, slow: true }) }, this.options.slowWriteMs ?? 10000)
    try {
      const result = await api.post('/api/retention', { retention_seconds: value }) as any
      if (!result || result.ok !== true || !seconds(result.retention_seconds) || result.retention_seconds !== value) throw new InvalidRetention()
      this.set({ phase: 'ready', seconds: value, outcome: 'confirmed', requested: value, checkedAt: new Date().toISOString() })
    } catch { this.set({ ...this.state, phase: 'read-error', outcome: 'uncertain', error: 'request', slow: false }) }
    finally { clearTimeout(timer); if (this.write === operation) this.write = undefined }
  }
}
export const globalRetentionFlow = new GlobalRetentionFlow()
