import { parseSamplePersistence, InvalidPersistenceStatusError, type SamplePersistenceStatus } from '../../../packages/core/src/sample-persistence'
import { LatestConfigRead } from './config-read'
import { runRequestWithTimeout, RequestTimeoutError } from './request-timeout'
export interface PersistenceReadState { readonly phase: 'loading' | 'ready' | 'error'; readonly value?: SamplePersistenceStatus; readonly error?: 'timeout' | 'invalid' | 'request' }
export class PersistenceStatusRead {
  private state: PersistenceReadState = Object.freeze({ phase: 'loading' })
  private owner = new LatestConfigRead()
  private active: symbol | undefined
  private listeners = new Set<() => void>()
  constructor(readonly objectId: number | null) { if (objectId !== null && (!Number.isSafeInteger(objectId) || objectId < 1)) throw new Error('Invalid persistence scope') }
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(state: PersistenceReadState) { this.state = Object.freeze(state); this.listeners.forEach(fn => fn()) }
  cancel() { this.owner.cancel(); this.active = undefined }
  async refresh(get: (url: string, signal: AbortSignal) => Promise<unknown>, force = false, timeoutMs = 10000) {
    if (this.active && !force) return
    const active = Symbol(); this.active = active
    this.set({ ...this.state, phase: 'loading', error: undefined })
    try {
      await this.owner.run(signal => runRequestWithTimeout(inner => get('/api/storage/persistence-status' + (this.objectId === null ? '' : '?object_id=' + this.objectId), inner), signal, timeoutMs).then(value => parseSamplePersistence(value, this.objectId)), value => this.set({ phase: 'ready', value }), error => this.set({ ...this.state, phase: 'error', error: error instanceof RequestTimeoutError ? 'timeout' : error instanceof InvalidPersistenceStatusError ? 'invalid' : 'request' }))
    } finally { if (this.active === active) this.active = undefined }
  }
}
