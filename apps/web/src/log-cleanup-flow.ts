import { LatestConfigRead } from './config-read'
import { RequestTimeoutError, runRequestWithTimeout } from './request-timeout'
import { parseLogCleanupPreview, parseLogCleanupResult, type LogCleanupPreview, type LogCleanupResult } from '../../../packages/core/src/log-cleanup'
export interface LogCleanupState {
  readonly phase: 'idle' | 'previewing' | 'preview-error' | 'ready' | 'saving' | 'completed' | 'rejected' | 'uncertain'
  readonly preview?: LogCleanupPreview; readonly previewAt?: string; readonly result?: LogCleanupResult
  readonly error?: 'timeout' | 'unsupported' | 'read' | 'conflict' | 'rejected'; readonly slow?: boolean
}
class CleanupHttpError extends Error { constructor(readonly status: number) { super('HTTP ' + status) } }
/** Per-tab memory journal. Preview reads are cancellable; cleanup POST is never aborted/timed out/replayed. */
export class LogCleanupFlow {
  private state: LogCleanupState = Object.freeze({ phase: 'idle' })
  private owner = new LatestConfigRead()
  private listeners = new Set<() => void>()
  private write?: symbol
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly options: { previewTimeoutMs?: number; slowWriteMs?: number } = {}) {}
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(value: LogCleanupState) { this.state = Object.freeze(value); this.listeners.forEach(fn => fn()) }
  closeRead() { this.owner.cancel(); if (this.state.phase === 'previewing') this.set({ phase: 'idle' }) }
  private async response(response: Response) { if (!response.ok) throw new CleanupHttpError(response.status); return response.json() as Promise<unknown> }
  async preview() {
    if (this.write) return
    this.set({ phase: 'previewing' })
    await this.owner.run(signal => runRequestWithTimeout(inner => this.fetcher('/api/logs/cleanup-preview', { signal: inner, cache: 'no-store' }).then(response => this.response(response)).then(parseLogCleanupPreview), signal, this.options.previewTimeoutMs ?? 10000), preview => this.set({ phase: 'ready', preview, previewAt: new Date().toISOString() }), error => this.set({ phase: 'preview-error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof CleanupHttpError && error.status === 404 ? 'unsupported' : 'read' }))
  }
  async confirm() {
    if (this.state.phase !== 'ready' || !this.state.preview?.count || this.write) return
    const preview = this.state.preview, previewAt = this.state.previewAt, operation = this.write = Symbol()
    this.owner.cancel(); this.set({ phase: 'saving', preview, previewAt, slow: false })
    const timer = setTimeout(() => { if (this.write === operation) this.set({ ...this.state, slow: true }) }, this.options.slowWriteMs ?? 10000)
    try {
      const response = await this.fetcher('/api/logs/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-probestation-config': '1' }, body: JSON.stringify({ expected: preview }) })
      const result = parseLogCleanupResult(await this.response(response), preview)
      this.set({ phase: 'completed', preview, previewAt, result })
    } catch (error) {
      const rejected = error instanceof CleanupHttpError && [400, 403, 404, 409, 413, 415].includes(error.status)
      this.set({ phase: rejected ? 'rejected' : 'uncertain', preview, previewAt, error: rejected ? error instanceof CleanupHttpError && error.status === 409 ? 'conflict' : 'rejected' : undefined })
    } finally { clearTimeout(timer); if (this.write === operation) this.write = undefined }
  }
}
export const logCleanupFlow = new LogCleanupFlow()
