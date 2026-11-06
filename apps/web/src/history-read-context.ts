import type { HistoryQueryEvent, HistoryQueryPlan } from './history-query-task'

export interface HistoryDefinitionDevice { id: number; mode?: string; slaveId?: number }
export interface HistoryDefinitionGroup { id: number; objectId?: number; name?: string; slaveId?: number; functionCode: number; startAddress: number; quantity: number }
export interface HistoryDefinitionPoint { id: number; objectId: number; groupId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string; slaveId?: number; sourceAmbiguous?: boolean; factor?: number; offset?: number; unit?: string | null; enumJson?: string | null; decimalPlaces?: number | null }
const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const optionalNumber = (value: unknown) => value == null || number(value)
const optionalString = (value: unknown) => value == null || typeof value === 'string'
/** Full known definitions: unselected points and group bounds also affect backend coverage/eligibility. */
export function historyReadContextKey(device: HistoryDefinitionDevice, groups: readonly HistoryDefinitionGroup[], points: readonly HistoryDefinitionPoint[]): string | null {
  if (!device || typeof device !== 'object' || !Array.isArray(groups) || !Array.isArray(points) || groups.some(g => !g || typeof g !== 'object') || points.some(p => !p || typeof p !== 'object')) return null
  if (!id(device.id) || !optionalString(device.mode) || !optionalNumber(device.slaveId) || new Set(groups.map(g => g.id)).size !== groups.length || new Set(points.map(p => p.id)).size !== points.length) return null
  if (groups.some(g => !id(g.id) || g.objectId !== undefined && g.objectId !== device.id || !optionalString(g.name) || !optionalNumber(g.slaveId) || ![g.functionCode, g.startAddress, g.quantity].every(number))) return null
  if (points.some(p => !id(p.id) || p.objectId !== device.id || !id(p.groupId) || !optionalString(p.alias) || ![p.functionCode, p.startAddress].every(number) || typeof p.dataType !== 'string' || !p.dataType || ![p.slaveId, p.factor, p.offset, p.decimalPlaces].every(optionalNumber) || ![p.unit, p.enumJson].every(optionalString) || p.sourceAmbiguous !== undefined && typeof p.sourceAmbiguous !== 'boolean')) return null
  const orderedGroups = [...groups].sort((a, b) => a.id - b.id), orderedPoints = [...points].sort((a, b) => a.id - b.id)
  return JSON.stringify([device.id, device.mode ?? null, device.slaveId ?? null,
    orderedGroups.map(g => [g.id, g.name ?? null, g.slaveId ?? null, g.functionCode, g.startAddress, g.quantity]),
    orderedPoints.map(p => [p.id, p.objectId, p.groupId, p.alias ?? null, p.functionCode, p.startAddress, p.dataType, p.slaveId ?? null, !!p.sourceAmbiguous, p.factor ?? 1, p.offset ?? 0, p.unit ?? null, p.enumJson ?? null, p.decimalPlaces ?? null])])
}
export interface HistoryReadState<T> { readonly plan: HistoryQueryPlan | null; readonly status: 'idle' | 'loading' | 'done' | 'error'; readonly data: T | null; readonly error: unknown; readonly lastContextKey: string | null }
/** Loading acquires ownership; completion/cancel/error can update only that same request. */
export function reduceHistoryRead<T>(previous: HistoryReadState<T> | null, plan: HistoryQueryPlan | null, event: HistoryQueryEvent<T>): HistoryReadState<T> | null {
  const lastContextKey = previous?.lastContextKey ?? null
  if (event.status === 'loading' || plan === null && event.status === 'idle') return Object.freeze({ plan, status: event.status, data: null, error: null, lastContextKey })
  if (!previous || previous.plan?.key !== plan?.key) return previous
  if (event.status === 'done') {
    if (!plan || event.plan.key !== plan.key) return previous
    return Object.freeze({ plan, status: 'done', data: event.data, error: null, lastContextKey: plan.contextKey })
  }
  return Object.freeze({ plan, status: event.status, data: null, error: event.status === 'error' ? event.error : null, lastContextKey })
}
/** Hide foreign results/errors immediately during render, before effect cleanup/new fetch can run. */
export function historyReadView<T>(plan: HistoryQueryPlan | null, state: HistoryReadState<T> | null) {
  const contextChanged = !!plan && state?.lastContextKey != null && state.lastContextKey !== plan.contextKey
  if (!plan) return { status: 'idle' as const, data: null, error: null, contextChanged: false }
  if (!state || state.plan?.key !== plan.key) return { status: 'loading' as const, data: null, error: null, contextChanged }
  return { status: state.status, data: state.status === 'done' ? state.data : null, error: state.status === 'error' ? state.error : null, contextChanged }
}
