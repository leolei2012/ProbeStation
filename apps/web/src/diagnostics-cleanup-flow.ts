import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'
import { parseDiagnosticsCleanupPreview, parseDiagnosticsCleanupResult, type DiagnosticsCleanupPreview, type DiagnosticsCleanupResult } from '../../../packages/core/src/diagnostics-cleanup'
export interface DiagnosticsCleanupState { readonly phase: 'idle' | 'previewing' | 'preview-error' | 'ready' | 'saving' | 'completed' | 'rejected' | 'uncertain'; readonly objectId?: number; readonly preview?: DiagnosticsCleanupPreview; readonly result?: DiagnosticsCleanupResult; readonly error?: 'timeout' | 'unavailable' | 'read'; readonly slow?: boolean }
class CleanupHttpError extends Error { constructor(readonly status: number) { super('Diagnostic cleanup HTTP error') } }
/** One in-memory journal per page. Writes have no abort, deadline, retry or legacy fallback. */
export class DiagnosticsCleanupFlow {
  private state: DiagnosticsCleanupState = Object.freeze({ phase: 'idle' })
  private owner = new LatestConfigRead()
  private write?: symbol
  private listeners = new Set<() => void>()
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly options: { previewTimeoutMs?: number; slowWriteMs?: number } = {}) {}
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(value: DiagnosticsCleanupState) { this.state = Object.freeze(value); this.listeners.forEach(fn => fn()) }
  closeRead() { this.owner.cancel(); if (this.state.phase === 'previewing') this.set({ phase: 'idle', objectId: this.state.objectId }) }
  private async response(response: Response) { if (!response.ok) throw new CleanupHttpError(response.status); return response.json() as Promise<unknown> }
  async preview(objectId: number) {
    if (this.write || this.state.phase === 'previewing' || !Number.isSafeInteger(objectId) || objectId < 1) return
    this.set({ phase: 'previewing', objectId })
    await this.owner.run(signal => runRequestWithTimeout(inner => this.fetcher('/api/monitor_objects/' + objectId + '/diagnostics/cleanup-preview', { signal: inner, cache: 'no-store' }).then(value => this.response(value)).then(value => parseDiagnosticsCleanupPreview(value, objectId)), signal, this.options.previewTimeoutMs ?? 10000), preview => this.set({ phase: 'ready', objectId, preview }), error => this.set({ phase: 'preview-error', objectId, error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof CleanupHttpError && [404, 503].includes(error.status) ? 'unavailable' : 'read' }))
  }
  async confirm(wantedTargetKey: string) {
    if (this.write || this.state.phase !== 'ready' || !this.state.preview || this.state.preview.targetKey !== wantedTargetKey) return
    const preview = this.state.preview, operation = this.write = Symbol(), objectId = preview.objectId
    this.owner.cancel(); this.set({ phase: 'saving', objectId, preview, slow: false })
    const timer = setTimeout(() => { if (this.write === operation) this.set({ ...this.state, slow: true }) }, this.options.slowWriteMs ?? 10000)
    try {
      const response = await this.fetcher('/api/monitor_objects/' + objectId + '/diagnostics/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-probestation-config': '1' }, body: JSON.stringify({ token: preview.token }) })
      const result = parseDiagnosticsCleanupResult(await this.response(response), preview)
      this.set({ phase: 'completed', objectId, preview, result })
    } catch (error) {
      const rejected = error instanceof CleanupHttpError && [400, 403, 404, 409, 413, 415].includes(error.status)
      this.set({ phase: rejected ? 'rejected' : 'uncertain', objectId, preview })
    } finally { clearTimeout(timer); if (this.write === operation) this.write = undefined }
  }
}
export const diagnosticsCleanupFlow = new DiagnosticsCleanupFlow()
