import type { PointDiagnosticIssue } from '../../../packages/core/src/point-diagnostics'
import { RequestTimeoutError, runRequestWithTimeout } from './request-timeout'

export interface PointDiagnosticReport {
  scope: 'point-table-structure'; ok: boolean; complete: true
  summary: { devices: number; groups: number; registers: number; errors: number; warnings: number; coveredPlaceholders: number }
  issues: PointDiagnosticIssue[]
}
export interface PointDiagnosticSnapshot { deviceId: number; requestedAt: string; receivedAt: string; report: PointDiagnosticReport }
export interface PointDiagnosticState { status: 'idle' | 'loading' | 'ready' | 'error'; snapshot: PointDiagnosticSnapshot | null; error: 'failed' | 'timeout' | 'invalid' | null }
export const initialPointDiagnosticState = (): PointDiagnosticState => ({ status: 'idle', snapshot: null, error: null })
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const id = (v: unknown): v is number => count(v) && v > 0
export class InvalidPointDiagnosticReport extends Error {}

/** Validate and project the read-only report. Unknown fields never enter downloaded reports. */
export function parsePointDiagnosticReport(input: unknown, deviceId: number): PointDiagnosticReport {
  const invalid = () => { throw new InvalidPointDiagnosticReport('Invalid point diagnostic report') }
  if (!id(deviceId) || !record(input) || input.scope !== 'point-table-structure' || input.complete !== true || typeof input.ok !== 'boolean' || !record(input.summary) || !Array.isArray(input.issues)) return invalid()
  const summary = {} as PointDiagnosticReport['summary']
  for (const key of ['devices', 'groups', 'registers', 'errors', 'warnings', 'coveredPlaceholders'] as const) {
    if (!count(input.summary[key])) return invalid()
    summary[key] = input.summary[key]
  }
  if (summary.devices !== 1 || summary.coveredPlaceholders > summary.registers) return invalid()
  const issues: PointDiagnosticIssue[] = input.issues.map(raw => {
    if (!record(raw) || raw.severity !== 'error' && raw.severity !== 'warning' || typeof raw.code !== 'string' || !raw.code || typeof raw.message !== 'string' || !raw.message) return invalid()
    const issue: PointDiagnosticIssue = { severity: raw.severity, code: raw.code, message: raw.message }
    for (const key of ['entityId', 'objectId', 'groupId'] as const) if (Object.hasOwn(raw, key)) {
      if (!id(raw[key]) || key === 'objectId' && raw[key] !== deviceId) return invalid()
      issue[key] = raw[key]
    }
    if (Object.hasOwn(raw, 'path')) { if (typeof raw.path !== 'string') return invalid(); issue.path = raw.path }
    if (Object.hasOwn(raw, 'slaveId')) { if (!count(raw.slaveId) || raw.slaveId > 255) return invalid(); issue.slaveId = raw.slaveId }
    if (Object.hasOwn(raw, 'area')) { if (typeof raw.area !== 'string' || !['coil', 'discrete-input', 'holding-register', 'input-register'].includes(raw.area)) return invalid(); issue.area = raw.area as PointDiagnosticIssue['area'] }
    if (Object.hasOwn(raw, 'registerIds')) { if (!Array.isArray(raw.registerIds) || !raw.registerIds.every(id)) return invalid(); issue.registerIds = [...raw.registerIds] }
    return issue
  })
  const errors = issues.filter(i => i.severity === 'error').length
  if (summary.errors !== errors || summary.warnings !== issues.length - errors || input.ok !== (errors === 0)) return invalid()
  return { scope: 'point-table-structure', ok: input.ok, complete: true, summary, issues }
}

/** One GET per entry/refresh, bounded and cancellable; no driver or write port exists here. */
export class PointDiagnosticsLoader {
  private sequence = 0
  private controller?: AbortController
  constructor(private readonly changed: (state: PointDiagnosticState) => void, private readonly timeoutMs = 10_000) {}
  cancel() { this.sequence++; this.controller?.abort(); this.controller = undefined }
  async refresh(deviceId: number, fetcher: (url: string, signal: AbortSignal) => Promise<unknown>) {
    this.cancel()
    const sequence = this.sequence, controller = this.controller = new AbortController(), requestedAt = new Date().toISOString()
    this.changed({ status: 'loading', snapshot: null, error: null })
    const current = () => sequence === this.sequence && !controller.signal.aborted
    try {
      if (!id(deviceId)) throw new InvalidPointDiagnosticReport('Invalid device ID')
      const input = await runRequestWithTimeout(signal => fetcher('/api/monitor_objects/' + deviceId + '/point-diagnostics', signal), controller.signal, this.timeoutMs)
      if (current()) this.changed({ status: 'ready', snapshot: { deviceId, requestedAt, receivedAt: new Date().toISOString(), report: parsePointDiagnosticReport(input, deviceId) }, error: null })
    } catch (error) {
      if (current()) this.changed({ status: 'error', snapshot: null, error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidPointDiagnosticReport ? 'invalid' : 'failed' })
    } finally { if (this.controller === controller) this.controller = undefined }
  }
}

export interface DiagnosticPoint { id: number; groupId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string; slaveId?: number }
export interface DiagnosticGroup { id: number; name: string }
export function filterRelatedDiagnosticIds(ids: readonly number[], query: string, points: readonly DiagnosticPoint[], labels: ReadonlyMap<number, { name: string; detail: string }>) {
  const byId = new Map(points.map(p => [p.id, p])), search = query.trim().toLocaleLowerCase()
  return [...new Set(ids)].filter(id => !search || (/^#?\d+$/.test(search) ? id === Number(search.replace('#', '')) : [labels.get(id)?.name, labels.get(id)?.detail, byId.get(id)?.dataType].join(' ').toLocaleLowerCase().includes(search)))
}
export function filterPointDiagnosticIssues(report: PointDiagnosticReport, severity: 'all' | 'error' | 'warning', query: string, points: readonly DiagnosticPoint[], groups: readonly DiagnosticGroup[]) {
  const text = query.trim().toLocaleLowerCase(), exact = /^#?([1-9]\d*)$/.exec(text), exactId = exact ? Number(exact[1]) : null
  const pointById = new Map(points.map(p => [p.id, p])), groupById = new Map(groups.map(g => [g.id, g]))
  return report.issues.filter(issue => {
    if (severity !== 'all' && issue.severity !== severity) return false
    if (!text) return true
    if (exactId !== null) return issue.registerIds?.includes(exactId) || issue.groupId === exactId || issue.entityId === exactId
    const related = (issue.registerIds ?? []).map(id => pointById.get(id)).filter((p): p is DiagnosticPoint => !!p)
    return [issue.code, issue.message, issue.path, issue.area, issue.slaveId, issue.groupId === undefined ? '' : groupById.get(issue.groupId)?.name, ...related.flatMap(p => [p.alias, p.dataType, p.slaveId, p.startAddress, groupById.get(p.groupId)?.name])].join(' ').toLocaleLowerCase().includes(text)
  })
}

export function pointDiagnosticDownload(snapshot: PointDiagnosticSnapshot) {
  // Reproject even caller-created snapshots; no connection settings or full point table are exported.
  const report = parsePointDiagnosticReport(snapshot.report, snapshot.deviceId)
  return JSON.stringify({ format: 'probestation-point-diagnostics', version: 1, deviceId: snapshot.deviceId, requestedAt: snapshot.requestedAt, receivedAt: snapshot.receivedAt, report }, null, 2)
}
