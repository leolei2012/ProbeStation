import { communicationScope, type CommunicationScope } from './communication-summary'
import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'

export const clampFrameLimit = (value: number) => Math.max(1, Math.min(2000, Math.trunc(value) || 200))
export class InvalidRawFrames extends Error { constructor() { super('Invalid raw capture response'); this.name = 'InvalidRawFrames' } }
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
export function parseRawFrames(value: unknown, scope: CommunicationScope, limit: number) {
  if (!integer(limit, 1, 2000) || !Array.isArray(value) || value.length > limit) throw new InvalidRawFrames()
  const ids = new Set<number>(), transport = scope.scope === 'channel' ? 'rtu' : 'tcp'
  const frames = value.map(raw => {
    if (!raw || typeof raw !== 'object' || !integer(raw.id, 1, Number.MAX_SAFE_INTEGER) || ids.has(raw.id) || raw.transport !== transport || !['tx', 'rx'].includes(raw.direction) || typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp)) || typeof raw.isException !== 'boolean' || !integer(raw.byteLength, 1, Number.MAX_SAFE_INTEGER) || typeof raw.hex !== 'string' || raw.hex.length !== raw.byteLength * 2 || !/^[0-9a-f]+$/i.test(raw.hex)) throw new InvalidRawFrames()
    ids.add(raw.id)
    for (const [field, max] of [['slaveId', 255], ['functionCode', 127], ['exceptionCode', 255]] as const) if (raw[field] !== undefined && !integer(raw[field], 0, max)) throw new InvalidRawFrames()
    if (raw.channelKey !== undefined && raw.channelKey !== scope.channelKey || raw.deviceId !== undefined && raw.deviceId !== scope.objectId) throw new InvalidRawFrames()
    return Object.freeze({ id: raw.id as number, timestamp: raw.timestamp as string, transport, direction: raw.direction as 'tx' | 'rx', hex: raw.hex as string, byteLength: raw.byteLength as number, isException: raw.isException as boolean,
      slaveId: raw.slaveId as number | undefined, functionCode: raw.functionCode as number | undefined, exceptionCode: raw.exceptionCode as number | undefined,
      sourceMetadataMatched: raw.channelKey === scope.channelKey && (transport === 'tcp' ? raw.deviceId === scope.objectId : raw.deviceId === undefined) })
  })
  return Object.freeze({ frames: Object.freeze(frames), receivedAt: new Date().toISOString(), limit })
}
export type RawFrameSnapshot = ReturnType<typeof parseRawFrames>
export interface RawFramesState { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly value?: RawFrameSnapshot; readonly error?: 'timeout' | 'invalid' | 'request' }
export class RawFramesRead {
  private state: RawFramesState = Object.freeze({ phase: 'idle' })
  private scope: CommunicationScope | null = null
  private owner = new LatestConfigRead()
  private active?: symbol
  private listeners = new Set<() => void>()
  constructor(device: Parameters<typeof communicationScope>[0] | null, readonly limit: number) {
    if (device) { try { this.scope = communicationScope(device); if (!integer(limit, 1, 2000)) throw new InvalidRawFrames() } catch { this.scope = null; this.state = Object.freeze({ phase: 'error', error: 'invalid' }) } }
  }
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(state: RawFramesState) { this.state = Object.freeze(state); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel(); this.active = undefined; if (this.state.phase === 'loading') this.set({ ...this.state, phase: 'idle' }) }
  invalidate() { this.cancel(); this.set({ phase: 'idle' }) }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
    if (!this.scope || this.active) return
    const scope = this.scope, active = Symbol(); this.active = active; this.set({ ...this.state, phase: 'loading', error: undefined })
    try {
      await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/monitor_objects/' + scope.objectId + '/frames?limit=' + this.limit, inner), signal, timeoutMs).then(value => parseRawFrames(value, scope, this.limit)), value => this.set({ phase: 'ready', value }), error => this.set({ ...this.state, phase: 'error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidRawFrames ? 'invalid' : 'request' }))
    } finally { if (this.active === active) this.active = undefined }
  }
}
