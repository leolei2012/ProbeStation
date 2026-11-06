import { parseRecordingIntervalStatus, type RecordingIntervalStatus } from '../../../packages/core/src/recording-attention'
import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout } from './request-timeout'

export interface RecordingAttentionState { phase: 'loading' | 'ready' | 'error'; value?: RecordingIntervalStatus }
export class RecordingAttentionRead {
  private owner = new LatestConfigRead()
  private state: RecordingAttentionState = Object.freeze({ phase: 'loading' })
  private listeners = new Set<() => void>()
  constructor(readonly deviceId: number) {}
  getSnapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(state: RecordingAttentionState) { this.state = Object.freeze(state); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel() }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
    this.set({ ...this.state, phase: 'loading' })
    await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/monitor_objects/' + this.deviceId + '/recording-interval-status', inner), signal, timeoutMs).then(value => parseRecordingIntervalStatus(value, this.deviceId)), value => this.set({ phase: 'ready', value }), () => this.set({ ...this.state, phase: 'error' }))
  }
}
