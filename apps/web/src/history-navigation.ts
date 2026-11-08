import { validSlaveId } from '../../../packages/core/src/sample-source'

export interface HistoryTarget { deviceId: number; view: string; start?: string; end?: string; registerId?: number; valueMode?: 'raw' | 'physical'; token?: number; pointSource?: string }
export interface HistoryNavigationAction { range?: { start: number; end: number }; focus?: { state: 'waiting' | 'found' | 'missing' | 'changed'; id: number }; valueMode?: 'raw' | 'physical'; invalid?: boolean }
export interface HistorySourcePoint { id: number; slaveId?: number; functionCode: number; startAddress: number; dataType: string }
/** Logical point source only; not an endpoint identity, revision or batch proof. */
export function historyPointSourceKey(point: Omit<HistorySourcePoint, 'id'>): string | null {
  return validSlaveId(point.slaveId) && Number.isSafeInteger(point.functionCode) && Number.isSafeInteger(point.startAddress) && point.startAddress >= 0 && typeof point.dataType === 'string' && !!point.dataType ? JSON.stringify([point.slaveId, point.functionCode, point.startAddress, point.dataType]) : null
}
export class HistoryNavigation {
  private key: string | null = null
  private pendingId: number | null = null
  cancelPending() { this.pendingId = null }
  consume(target: HistoryTarget | null, deviceId: number, registerIds: readonly number[], ready: boolean, points?: readonly HistorySourcePoint[]): HistoryNavigationAction | null {
    if (!target || target.deviceId !== deviceId || target.view !== 'history' || !target.start || !target.end) { this.cancelPending(); return null }
    const key = JSON.stringify([target.deviceId, target.token ?? null, target.start, target.end, target.registerId ?? null, target.valueMode ?? null, target.pointSource ?? null])
    const action: HistoryNavigationAction = {}
    if (key !== this.key) {
      this.key = key; this.pendingId = null
      const start = Date.parse(target.start), end = Date.parse(target.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || target.registerId !== undefined && (!Number.isSafeInteger(target.registerId) || target.registerId < 1) || target.valueMode !== undefined && !['raw', 'physical'].includes(target.valueMode) || target.pointSource !== undefined && (typeof target.pointSource !== 'string' || !target.pointSource || target.registerId === undefined)) return { invalid: true }
      action.range = { start, end }; this.pendingId = target.registerId ?? null
      if (target.valueMode !== undefined) action.valueMode = target.valueMode
    }
    if (this.pendingId !== null) {
      const id = this.pendingId
      if (!ready) { if (action.range) action.focus = { state: 'waiting', id } }
      else {
        const matches = points?.filter(point => point.id === id)
        const state = !registerIds.includes(id) ? 'missing' : target.pointSource !== undefined && (matches?.length !== 1 || historyPointSourceKey(matches[0]) !== target.pointSource) ? 'changed' : 'found'
        action.focus = { state, id }; this.pendingId = null
      }
    }
    return action.range || action.focus ? action : null
  }
}
