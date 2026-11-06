import { runRequestWithTimeout } from './request-timeout'

export interface DeferredState<T> { status: 'idle' | 'loading' | 'ready' | 'error'; value: T | null }

/** Shared display-code loader only. It never receives message content, API credentials or model requests. */
export class DeferredResource<T> {
  private state: DeferredState<T> = Object.freeze({ status: 'idle', value: null })
  private listeners = new Set<() => void>()
  private pending: Promise<void> | null = null
  constructor(private readonly importer: () => Promise<T>, private readonly timeoutMs = 10_000) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: DeferredState<T>) { this.state = Object.freeze(state); for (const listener of this.listeners) listener() }
  load = (retry = false): Promise<void> => {
    if (this.pending) return this.pending
    if (this.state.status === 'ready' || this.state.status === 'error' && !retry) return Promise.resolve()
    // Start in a microtask so all consumers share the pending operation before notifications can reenter.
    this.pending = Promise.resolve().then(async () => {
      this.publish({ status: 'loading', value: null })
      try {
        // Dynamic imports cannot be aborted. A late result after timeout is ignored; the next manual retry may reuse the browser cache.
        const value = await runRequestWithTimeout(() => this.importer(), new AbortController().signal, this.timeoutMs)
        this.publish({ status: 'ready', value })
      } catch { this.publish({ status: 'error', value: null }) }
      finally { this.pending = null }
    })
    return this.pending
  }
}
