import { LatestConfigRead } from './config-read'
import { RequestTimeoutError, runRequestWithTimeout } from './request-timeout'
export const RUNTIME_LOG_LIMIT = 200
export const RUNTIME_LOG_PAGE_SIZE = 20
export interface RuntimeLog { readonly id: number; readonly ts: string; readonly level: string | null; readonly source: string | null; readonly message: string | null }
export const UNRECORDED_LOG_LEVEL = Symbol('unrecorded-log-level')
export type RuntimeLogLevelFilter = string | null | typeof UNRECORDED_LOG_LEVEL
export interface RuntimeLogState { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly rows?: readonly RuntimeLog[]; readonly receivedAt?: string; readonly error?: 'timeout' | 'invalid' | 'request' }
export class InvalidRuntimeLogs extends Error { constructor() { super('Invalid runtime logs response') } }
export function parseRuntimeLogs(input: unknown): readonly RuntimeLog[] {
  if (!Array.isArray(input) || input.length > RUNTIME_LOG_LIMIT) throw new InvalidRuntimeLogs()
  let previous = Infinity
  return Object.freeze(input.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Number.isSafeInteger(row.id) || row.id < 1 || row.id >= previous || typeof row.ts !== 'string' || !['level', 'source', 'message'].every(key => row[key] === null || typeof row[key] === 'string')) throw new InvalidRuntimeLogs()
    previous = row.id
    return Object.freeze({ id: row.id, ts: row.ts, level: row.level, source: row.source, message: row.message })
  }))
}
export function filterRuntimeLogs(rows: readonly RuntimeLog[], level: RuntimeLogLevelFilter, query: string): readonly RuntimeLog[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return rows.filter(row => (level === UNRECORDED_LOG_LEVEL ? row.level === null : level === null || row.level === level) && terms.every(term => `${row.id}\n${row.ts}\n${row.level ?? ''}\n${row.source ?? ''}\n${row.message ?? ''}`.toLowerCase().includes(term)))
}
/** Existing bounded GET only; never clears logs, writes config or calls a model. */
export class RuntimeLogsRead {
  private state: RuntimeLogState = Object.freeze({ phase: 'idle' })
  private owner = new LatestConfigRead()
  private active?: symbol
  private listeners = new Set<() => void>()
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(value: RuntimeLogState) { this.state = Object.freeze(value); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel(); this.active = undefined }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
    if (this.active) return
    const active = this.active = Symbol()
    this.set({ ...this.state, phase: 'reading', error: undefined })
    try {
      await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/logs?limit=' + RUNTIME_LOG_LIMIT, inner), signal, timeoutMs).then(parseRuntimeLogs), rows => this.set({ phase: 'ready', rows, receivedAt: new Date().toISOString() }), error => this.set({ ...this.state, phase: 'error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidRuntimeLogs ? 'invalid' : 'request' }))
    } finally { if (this.active === active) this.active = undefined }
  }
}
