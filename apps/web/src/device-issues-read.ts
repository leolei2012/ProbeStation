import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'

export type DataTarget = { deviceId: number; view: 'live' | 'history' | 'diagnostics'; label: string; registerId?: number; start?: string; end?: string; valueMode?: 'raw' | 'physical'; token?: number }
export type DeviceIssue = Omit<DataTarget, 'token'> & { readonly reason: string }
class InvalidDeviceIssues extends Error {}
const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
export function parseDeviceIssues(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.issues) || value.checkedAt !== undefined && (!Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 || !Number.isFinite(new Date(value.checkedAt).getTime()))) throw new InvalidDeviceIssues()
  const issues: Readonly<DeviceIssue>[] = value.issues.map((issue: any) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue) || !id(issue.deviceId) || !['live', 'history', 'diagnostics'].includes(issue.view) || typeof issue.label !== 'string' || typeof issue.reason !== 'string' || issue.registerId !== undefined && !id(issue.registerId) || issue.valueMode !== undefined && !['raw', 'physical'].includes(issue.valueMode)) throw new InvalidDeviceIssues()
    for (const field of ['start', 'end']) if (issue[field] !== undefined && (typeof issue[field] !== 'string' || !Number.isFinite(Date.parse(issue[field])))) throw new InvalidDeviceIssues()
    return Object.freeze({ deviceId: issue.deviceId, view: issue.view, label: issue.label, reason: issue.reason,
      ...(issue.registerId === undefined ? {} : { registerId: issue.registerId }), ...(issue.start === undefined ? {} : { start: issue.start }), ...(issue.end === undefined ? {} : { end: issue.end }), ...(issue.valueMode === undefined ? {} : { valueMode: issue.valueMode }) })
  })
  return Object.freeze({ issues: Object.freeze(issues), checkedAt: value.checkedAt === undefined ? null : value.checkedAt as number, receivedAt: new Date().toISOString() })
}
export type DeviceIssuesSnapshot = ReturnType<typeof parseDeviceIssues>
export interface DeviceIssuesReadState { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly value?: DeviceIssuesSnapshot; readonly error?: 'timeout' | 'invalid' | 'request' }
export class DeviceIssuesRead {
  private state: DeviceIssuesReadState = Object.freeze({ phase: 'idle' })
  private owner = new LatestConfigRead()
  private active?: symbol
  private listeners = new Set<() => void>()
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(value: DeviceIssuesReadState) { this.state = Object.freeze(value); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel(); this.active = undefined; if (this.state.phase === 'loading') this.set({ ...this.state, phase: 'idle' }) }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
    if (this.active) return
    const active = this.active = Symbol(); this.set({ ...this.state, phase: 'loading', error: undefined })
    try {
      await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/ai/issues', inner), signal, timeoutMs).then(parseDeviceIssues), value => this.set({ phase: 'ready', value }), error => this.set({ ...this.state, phase: 'error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidDeviceIssues ? 'invalid' : 'request' }))
    } finally { if (this.active === active) this.active = undefined }
  }
}
