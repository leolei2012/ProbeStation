import { runRequestWithTimeout } from './request-timeout'

/** Single-flight REST reads scoped to selection/channel generations; never handles writes. */
export class RealtimeFallbackRead<T> {
  private objectId: number | null = null
  private connected = false
  private stopped = false
  private generation = 0
  private active?: { controller: AbortController }
  constructor(private readonly options: {
    read: (objectId: number, signal: AbortSignal) => Promise<T>
    accept: (objectId: number, value: T) => void
    failed: (objectId: number, error: unknown) => void
    timeoutMs?: number
  }) { if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Invalid fallback timeout') }
  private invalidate() {
    this.generation++
    const old = this.active; this.active = undefined
    old?.controller.abort()
  }
  select(objectId: number | null) {
    if (objectId !== null && (!Number.isSafeInteger(objectId) || objectId < 1)) throw new Error('Invalid fallback device')
    if (this.objectId === objectId || this.stopped) return
    this.objectId = objectId; this.invalidate()
  }
  setConnected(connected: boolean) {
    if (this.connected === connected || this.stopped) return
    this.connected = connected; this.invalidate()
  }
  dispose() { this.stopped = true; this.invalidate() }
  async refresh() {
    if (this.stopped || this.connected || this.objectId === null || this.active) return
    const objectId = this.objectId, generation = this.generation, active = this.active = { controller: new AbortController() }
    const current = () => !this.stopped && !this.connected && this.objectId === objectId && this.generation === generation && this.active === active && !active.controller.signal.aborted
    try {
      const value = await runRequestWithTimeout(signal => this.options.read(objectId, signal), active.controller.signal, this.options.timeoutMs ?? 10000)
      if (current()) this.options.accept(objectId, value)
    } catch (error) { if (current()) this.options.failed(objectId, error) }
    finally { if (this.active === active) this.active = undefined }
  }
}
