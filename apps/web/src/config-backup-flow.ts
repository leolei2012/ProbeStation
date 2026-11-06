import { RequestTimeoutError, runRequestWithTimeout } from './request-timeout'

export interface BackupCounts { devices: number; groups: number; registers: number; rules: number }
export interface BackupPreview { counts: BackupCounts; devices: { name: string; mode: 'master' | 'slave'; transport: 'tcp' | 'rtu'; endpoint: string | null; sameName: boolean }[] }
export interface BackupRestoreResult extends BackupCounts { deviceIds: number[]; warnings: string[] }
export interface BackupFlowState {
  phase: 'idle' | 'previewing' | 'ready' | 'preview-error' | 'restoring' | 'completed' | 'rejected' | 'uncertain'
  fileName: string; preview: BackupPreview | null; result: BackupRestoreResult | null
  error: 'invalid-file' | 'invalid-preview' | 'preview-timeout' | 'preview-failed' | null; detail: string; slow: boolean
}
const empty = (): BackupFlowState => ({ phase: 'idle', fileName: '', preview: null, result: null, error: null, detail: '', slow: false })
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const countKeys = ['devices', 'groups', 'registers', 'rules'] as const
class InvalidBackupFile extends Error {}
class InvalidBackupPreview extends Error {}
class BackupHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super('HTTP ' + status) }
}
function countsOf(value: unknown): BackupCounts {
  if (!record(value) || countKeys.some(key => !count(value[key]))) throw new InvalidBackupPreview()
  return Object.fromEntries(countKeys.map(key => [key, value[key]])) as unknown as BackupCounts
}
function equalCounts(a: BackupCounts, b: BackupCounts) { return countKeys.every(key => a[key] === b[key]) }
export function parseBackupPreview(value: unknown, expected: BackupCounts): BackupPreview {
  if (!record(value) || !Array.isArray(value.devices)) throw new InvalidBackupPreview()
  const counts = countsOf(value.counts)
  if (!equalCounts(counts, expected) || value.devices.length !== counts.devices) throw new InvalidBackupPreview()
  const devices = value.devices.map(d => {
    if (!record(d) || typeof d.name !== 'string' || d.mode !== 'master' && d.mode !== 'slave' || d.transport !== 'tcp' && d.transport !== 'rtu' || d.endpoint !== null && typeof d.endpoint !== 'string' || typeof d.sameName !== 'boolean') throw new InvalidBackupPreview()
    return { name: d.name, mode: d.mode, transport: d.transport, endpoint: d.endpoint, sameName: d.sameName } as BackupPreview['devices'][number]
  })
  return { counts, devices }
}
export function parseBackupRestoreResult(value: unknown, expected: BackupCounts): BackupRestoreResult {
  const counts = countsOf(value)
  if (!record(value) || !equalCounts(counts, expected) || !Array.isArray(value.deviceIds) || value.deviceIds.length !== counts.devices || value.deviceIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value.deviceIds).size !== value.deviceIds.length || value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(w => typeof w !== 'string'))) throw new Error('Invalid restore result')
  return { ...counts, deviceIds: [...value.deviceIds], warnings: [...(value.warnings as string[] | undefined ?? [])] }
}

/** In-memory per-tab operation journal. Writes are never aborted, timed out or retried. */
export class ConfigBackupFlow {
  private state: BackupFlowState = Object.freeze(empty())
  private listeners = new Set<() => void>()
  private sequence = 0
  private previewController?: AbortController
  private pendingBody: string | null = null
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly options: { previewTimeoutMs?: number; slowRestoreMs?: number } = {}) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: BackupFlowState) {
    if (state.preview) { state.preview.devices.forEach(Object.freeze); Object.freeze(state.preview.devices); Object.freeze(state.preview.counts); Object.freeze(state.preview) }
    if (state.result) { Object.freeze(state.result.deviceIds); Object.freeze(state.result.warnings); Object.freeze(state.result) }
    this.state = Object.freeze(state)
    for (const listener of this.listeners) listener()
  }
  cancelPreview = () => {
    this.sequence++; this.previewController?.abort(); this.previewController = undefined
    if (this.state.phase === 'previewing' || this.state.phase === 'ready') { this.pendingBody = null; this.publish(empty()) }
  }
  private async send(action: 'preview' | 'restore', body: string, signal?: AbortSignal) {
    const response = await this.fetcher('/api/config/backup/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-probestation-config': '1' }, body, ...(signal ? { signal } : {}) })
    if (!response.ok) {
      const data = await response.json().catch(() => null), detail = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : ''
      throw new BackupHttpError(response.status, detail.slice(0, 1000))
    }
    return response.json() as Promise<unknown>
  }
  async preview(fileName: string, read: () => Promise<string>) {
    if (this.state.phase === 'restoring') return
    this.cancelPreview()
    const sequence = this.sequence, controller = this.previewController = new AbortController()
    this.pendingBody = null; this.publish({ ...empty(), phase: 'previewing', fileName })
    const current = () => sequence === this.sequence && !controller.signal.aborted
    try {
      const result = await runRequestWithTimeout(async signal => {
        let backup: unknown
        try { backup = JSON.parse(await read()) } catch { throw new InvalidBackupFile() }
        signal.throwIfAborted()
        if (!record(backup) || backup.format !== 'probestation-config' || backup.version !== 1 || countKeys.some(key => !Array.isArray(backup[key]))) throw new InvalidBackupFile()
        const expected = Object.fromEntries(countKeys.map(key => [key, (backup[key] as unknown[]).length])) as unknown as BackupCounts, body = JSON.stringify(backup)
        const preview = parseBackupPreview(await this.send('preview', body, signal), expected)
        return { body, preview }
      }, controller.signal, this.options.previewTimeoutMs ?? 10_000)
      if (!current()) return
      this.pendingBody = result.body; this.publish({ ...empty(), phase: 'ready', fileName, preview: result.preview })
    } catch (error) {
      if (current()) this.publish({ ...empty(), phase: 'preview-error', fileName, error: error instanceof InvalidBackupFile ? 'invalid-file' : error instanceof InvalidBackupPreview ? 'invalid-preview' : error instanceof RequestTimeoutError ? 'preview-timeout' : 'preview-failed', detail: error instanceof BackupHttpError ? error.message + (error.detail ? ': ' + error.detail : '') : '' })
    } finally { if (this.previewController === controller) this.previewController = undefined }
  }
  async restore() {
    if (this.state.phase !== 'ready' || !this.pendingBody || !this.state.preview) return
    const body = this.pendingBody, preview = this.state.preview, fileName = this.state.fileName
    // Consume the proposal synchronously, before any network call or React render can run again.
    this.pendingBody = null; this.publish({ ...empty(), phase: 'restoring', preview, fileName })
    const timer = setTimeout(() => { if (this.state.phase === 'restoring') this.publish({ ...this.state, slow: true }) }, this.options.slowRestoreMs ?? 10_000)
    try {
      const result = parseBackupRestoreResult(await this.send('restore', body), preview.counts)
      this.publish({ ...empty(), phase: 'completed', preview, fileName, result })
    } catch (error) {
      // These statuses are rejected by existing request guards/validation, before commit. All other failures may have committed.
      const rejected = error instanceof BackupHttpError && [400, 403, 413, 415].includes(error.status)
      this.publish({ ...empty(), phase: rejected ? 'rejected' : 'uncertain', preview, fileName, detail: error instanceof BackupHttpError ? error.message + (rejected && error.detail ? ': ' + error.detail : '') : '' })
    } finally { clearTimeout(timer) }
  }
}

export const configBackupFlow = new ConfigBackupFlow()
