import { randomUUID } from 'node:crypto'
import { diagnosticToken, type DiagnosticsCleanupTarget, type DiagnosticsCleanupPreview, type DiagnosticsCleanupResult } from '../../core/src/diagnostics-cleanup.ts'
export class DiagnosticsCleanupRefused extends Error {}
export class DiagnosticsCleanupUncertain extends Error {}
export interface CleanupTarget { target: DiagnosticsCleanupTarget; identity: string; configurationScope: symbol; driver: { getDiagnostics: () => any; clearDiagnostics: () => void } }
interface Entry { current: CleanupTarget; preview: DiagnosticsCleanupPreview; expires: number; phase: 'ready' | 'applying' | 'uncertain' | 'completed' | 'refused'; result?: DiagnosticsCleanupResult }
const counters = ['bufferedFrames', 'txFrames', 'rxFrames', 'successCount', 'errorCount', 'timeoutCount', 'consecutiveErrors'] as const
function counts(current: CleanupTarget) {
  const value = current.driver.getDiagnostics(), target = current.target
  if (!value || value.scope !== target.scope || value.channelKey !== target.channelKey || (target.scope === 'device' ? value.deviceId !== target.objectId : value.deviceId !== undefined) || counters.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) || !Number.isSafeInteger(value.successCount + value.errorCount) || typeof value.recentErrorRate !== 'number' || !Number.isFinite(value.recentErrorRate) || value.recentErrorRate < 0 || value.recentErrorRate > 1) throw new Error('Unsupported diagnostic counters')
  return { ...value }
}
/** Local diagnostic memory only. A token can invoke clear at most once, including thrown/unknown outcomes. */
export class DiagnosticsCleanup {
  private entries = new Map<string, Entry>()
  constructor(private readonly current: (objectId: number) => CleanupTarget | null, private readonly options: { now?: () => number; token?: () => string; ttlMs?: number; capacity?: number } = {}) {}
  private now() { return (this.options.now ?? Date.now)() }
  private prune() { const now = this.now(); for (const [token, entry] of this.entries) if (entry.expires <= now && entry.phase !== 'applying') this.entries.delete(token) }
  preview(objectId: number): DiagnosticsCleanupPreview {
    this.prune()
    if (this.entries.size >= (this.options.capacity ?? 100)) throw new DiagnosticsCleanupRefused()
    const current = this.current(objectId)
    if (!current || typeof current.configurationScope !== 'symbol') throw new DiagnosticsCleanupRefused()
    const value = counts(current), expires = this.now() + (this.options.ttlMs ?? 600000), token = (this.options.token ?? randomUUID)()
    if (!diagnosticToken(token) || this.entries.has(token)) throw new DiagnosticsCleanupRefused()
    const preview = Object.freeze({ ...current.target, version: 1 as const, token, expiresAt: new Date(expires).toISOString(), bufferedFrames: value.bufferedFrames, successCount: value.successCount, errorCount: value.errorCount })
    this.entries.set(token, { current: { target: Object.freeze({ ...current.target }), identity: current.identity, configurationScope: current.configurationScope, driver: current.driver }, preview, expires, phase: 'ready' }); return preview
  }
  confirm(objectId: number, token: string): DiagnosticsCleanupResult {
    this.prune()
    const entry = this.entries.get(token)
    if (!entry || entry.preview.objectId !== objectId) throw new DiagnosticsCleanupRefused()
    if (entry.phase === 'completed') return entry.result!
    if (entry.phase === 'refused') throw new DiagnosticsCleanupRefused()
    if (entry.phase !== 'ready') throw new DiagnosticsCleanupUncertain()
    const matches = (current: CleanupTarget | null) => current && current.driver === entry.current.driver && current.identity === entry.current.identity && current.configurationScope === entry.current.configurationScope && current.target.targetKey === entry.preview.targetKey
    entry.phase = 'applying'
    let started = false
    try {
      const current = this.current(objectId)
      if (!matches(current)) throw new DiagnosticsCleanupRefused()
      const before = counts(current!)
      if (!matches(this.current(objectId))) throw new DiagnosticsCleanupRefused()
      started = true
      current!.driver.clearDiagnostics()
      const after = counts(current!)
      if (counters.some(key => after[key] !== 0) || after.recentErrorRate !== 0 || ['lastResponseMs', 'averageResponseMs', 'maxResponseMs', 'lastSuccessTime', 'lastErrorTime', 'lastError'].some(key => after[key] !== undefined)) throw new Error('Clear not verified')
      entry.result = Object.freeze({ ...entry.current.target, ok: true, token, completedAt: new Date(this.now()).toISOString(), clearedFrames: before.bufferedFrames, clearedRequests: before.successCount + before.errorCount })
      entry.phase = 'completed'; return entry.result
    } catch (error) { if (!started && error instanceof DiagnosticsCleanupRefused) { entry.phase = 'refused'; throw error }; entry.phase = 'uncertain'; throw new DiagnosticsCleanupUncertain() }
  }
}
