export interface HistoryTarget { deviceId: number; view: string; start?: string; end?: string; registerId?: number; token?: number }
export interface HistoryNavigationAction { range?: { start: number; end: number }; focus?: { state: 'waiting' | 'found' | 'missing'; id: number }; invalid?: boolean }
export class HistoryNavigation {
  private key: string | null = null
  private pendingId: number | null = null
  cancelPending() { this.pendingId = null }
  consume(target: HistoryTarget | null, deviceId: number, registerIds: readonly number[], ready: boolean): HistoryNavigationAction | null {
    if (!target || target.deviceId !== deviceId || target.view !== 'history' || !target.start || !target.end) { this.cancelPending(); return null }
    const key = JSON.stringify([target.deviceId, target.token ?? null, target.start, target.end, target.registerId ?? null])
    const action: HistoryNavigationAction = {}
    if (key !== this.key) {
      this.key = key; this.pendingId = null
      const start = Date.parse(target.start), end = Date.parse(target.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || target.registerId !== undefined && (!Number.isSafeInteger(target.registerId) || target.registerId < 1)) return { invalid: true }
      action.range = { start, end }; this.pendingId = target.registerId ?? null
    }
    if (this.pendingId !== null) {
      const id = this.pendingId
      if (!ready) { if (action.range) action.focus = { state: 'waiting', id } }
      else { action.focus = { state: registerIds.includes(id) ? 'found' : 'missing', id }; this.pendingId = null }
    }
    return action.range || action.focus ? action : null
  }
}
