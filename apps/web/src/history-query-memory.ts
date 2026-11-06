import { historyTimeRange, resolveHistoryTimeRange, type HistoryInputZone } from './history-time-range'

export interface QueryMemoryDevice { id: number; mode: string; transport: string; ip?: string; port?: number; serialPath?: string | null; slaveId?: number; baudRate?: number; parity?: string; stopBits?: number; dataBits?: number; flowControl?: string }
export interface QueryMemoryPoint { id: number; objectId: number; groupId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string; slaveId?: number; sourceAmbiguous?: boolean; factor?: number; offset?: number; unit?: string | null; enumJson?: string | null; decimalPlaces?: number | null }
export interface RememberedPoint { readonly id: number; readonly name: string; readonly source: number | null; readonly sourceAmbiguous: boolean; readonly functionCode: number; readonly address: number; readonly dataType: string; readonly signature: string }
export interface QueryMemoryContext { readonly deviceId: number; readonly deviceKey: string | null; readonly points: ReadonlyMap<number, RememberedPoint | null> }
export interface RememberedQuery {
  readonly id: number; readonly name: string; readonly createdAt: string; readonly deviceId: number; readonly deviceKey: string
  readonly start: number; readonly end: number; readonly mode: 'chart' | 'table'; readonly valueMode: 'raw' | 'physical'; readonly inputZone: HistoryInputZone; readonly scope: 'full' | 'viewport'
  readonly points: readonly RememberedPoint[]; readonly signature: string
}
export type RememberedQueryInput = Pick<RememberedQuery, 'start' | 'end' | 'mode' | 'valueMode' | 'inputZone' | 'scope'> & { registerIds: readonly number[] }
export class QueryMemoryError extends Error {
  constructor(readonly code: 'waiting' | 'invalid-name' | 'invalid-query' | 'invalid-points' | 'device-changed' | 'points-changed' | 'missing') { super(code) }
}
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
/** Project known configuration fields only. No samples, credentials, model settings or inferred identities. */
export function queryMemoryContext(device: QueryMemoryDevice, points: readonly QueryMemoryPoint[]): QueryMemoryContext {
  const deviceKey = id(device.id) && typeof device.mode === 'string' && typeof device.transport === 'string' && [device.port, device.slaveId, device.baudRate, device.stopBits, device.dataBits].every(v => v === undefined || Number.isFinite(v)) ? JSON.stringify([device.id, device.mode, device.transport, device.ip ?? null, device.port ?? null, device.serialPath ?? null, device.mode === 'slave' ? device.slaveId ?? null : null, device.baudRate ?? null, device.parity ?? null, device.stopBits ?? null, device.dataBits ?? null, device.flowControl ?? null]) : null
  const byId = new Map<number, RememberedPoint | null>()
  for (const p of points) {
    if (!id(p.id)) continue
    if (byId.has(p.id) || p.objectId !== device.id || !id(p.groupId) || !Number.isSafeInteger(p.functionCode) || !Number.isSafeInteger(p.startAddress) || typeof p.dataType !== 'string' || !p.dataType || ![p.factor, p.offset, p.slaveId, p.decimalPlaces].every(v => v == null || Number.isFinite(v))) { byId.set(p.id, null); continue }
    const signature = JSON.stringify([p.id, p.objectId, p.groupId, p.alias, p.functionCode, p.startAddress, p.dataType, p.slaveId ?? null, !!p.sourceAmbiguous, p.factor ?? 1, p.offset ?? 0, p.unit ?? null, p.enumJson ?? null, p.decimalPlaces ?? null])
    byId.set(p.id, Object.freeze({ id: p.id, name: p.alias || '#' + p.id, source: p.slaveId ?? null, sourceAmbiguous: !!p.sourceAmbiguous, functionCode: p.functionCode, address: p.startAddress, dataType: p.dataType, signature }))
  }
  return Object.freeze({ deviceId: device.id, deviceKey, points: byId })
}
export function rememberedQueryCompatibility(query: RememberedQuery, context: QueryMemoryContext, ready: boolean) {
  const missing: number[] = [], changed: number[] = []
  if (!ready) return { kind: 'waiting' as const, missing, changed }
  if (context.deviceId !== query.deviceId || context.deviceKey !== query.deviceKey || !context.deviceKey) return { kind: 'device-changed' as const, missing, changed }
  for (const point of query.points) {
    if (!context.points.has(point.id)) missing.push(point.id)
    else if (context.points.get(point.id)?.signature !== point.signature) changed.push(point.id)
  }
  return { kind: missing.length || changed.length ? 'points-changed' as const : 'ready' as const, missing, changed }
}

/** One device-view lifetime, retained across history tab unmounts. No storage, requests or automatic recording. */
export class HistoryQueryMemory {
  private items: readonly RememberedQuery[] = Object.freeze([])
  private sequence = 0
  private listeners = new Set<() => void>()
  constructor(private readonly deviceId: number) {}
  snapshot = () => this.items
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(items: readonly RememberedQuery[]) { this.items = Object.freeze(items); for (const listener of this.listeners) listener() }
  save(name: string, input: RememberedQueryInput, context: QueryMemoryContext, ready: boolean, now = Date.now()) {
    if (!ready) throw new QueryMemoryError('waiting')
    if (context.deviceId !== this.deviceId || !context.deviceKey) throw new QueryMemoryError('device-changed')
    if (typeof name !== 'string' || !name.trim()) throw new QueryMemoryError('invalid-name')
    const range = resolveHistoryTimeRange(historyTimeRange(input.start, input.end, input.inputZone))
    if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || !range.valid || !Number.isFinite(new Date(now).getTime()) || !['table', 'chart'].includes(input.mode) || !['raw', 'physical'].includes(input.valueMode) || !['local', 'utc'].includes(input.inputZone) || !['full', 'viewport'].includes(input.scope) || input.scope === 'viewport' && input.mode !== 'chart') throw new QueryMemoryError('invalid-query')
    if (!input.registerIds.length || input.registerIds.some(value => !id(value)) || new Set(input.registerIds).size !== input.registerIds.length) throw new QueryMemoryError('invalid-points')
    const points = [...input.registerIds].sort((a, b) => a - b).map(value => context.points.get(value))
    if (points.some(point => !point)) throw new QueryMemoryError('invalid-points')
    const signature = JSON.stringify([context.deviceKey, range.start, range.end, input.mode, input.valueMode, input.inputZone, input.scope, points.map(p => p!.signature)])
    const duplicate = this.items.find(item => item.name === name.trim() && item.signature === signature)
    if (duplicate) return { entry: duplicate, added: false }
    const entry: RememberedQuery = Object.freeze({ id: ++this.sequence, name: name.trim(), createdAt: new Date(now).toISOString(), deviceId: context.deviceId, deviceKey: context.deviceKey, start: range.start, end: range.end, mode: input.mode, valueMode: input.valueMode, inputZone: input.inputZone, scope: input.scope, points: Object.freeze(points as RememberedPoint[]), signature })
    this.publish([entry, ...this.items]); return { entry, added: true }
  }
  restore(queryId: number, context: QueryMemoryContext, ready: boolean, apply: (query: RememberedQuery) => void) {
    const entry = this.items.find(item => item.id === queryId)
    if (!entry) throw new QueryMemoryError('missing')
    const check = rememberedQueryCompatibility(entry, context, ready)
    if (check.kind !== 'ready') throw new QueryMemoryError(check.kind)
    apply(entry)
  }
  remove(queryId: number) { if (this.items.some(item => item.id === queryId)) this.publish(this.items.filter(item => item.id !== queryId)) }
}
