/** Raw alarm interpretation and configured acquisition source; never physical authentication. */
const pointShape = { id: 'id', objectId: 'id', groupId: 'id', functionCode: 'number', startAddress: 'number', dataType: 'text' } as const
const groupShape = { id: 'id', functionCode: 'number', startAddress: 'number', quantity: 'number', mode: 'text' } as const
const tcpShape = { transport: 'text', ip: 'text', port: 'number' } as const
const rtuShape = { transport: 'text', serialPath: 'text?', baudRate: 'number', parity: 'text', stopBits: 'number', dataBits: 'number', flowControl: 'text' } as const
type Snapshot<S> = { readonly [K in keyof S]: S[K] extends 'id' | 'number' ? number : S[K] extends 'text?' ? string | null : string }
export interface AlarmContext {
  readonly version: 1
  readonly point: Snapshot<typeof pointShape>
  readonly group: Snapshot<typeof groupShape>
  readonly device: Readonly<{ id: number; mode: 'master' | 'slave'; slaveId: number; connection: Snapshot<typeof tcpShape> | Snapshot<typeof rtuShape> }>
}
export const invalidAlarmContext = (): never => { throw Object.assign(new Error('告警点位或来源条件不完整，请刷新配置并重新打开窗口。'), { statusCode: 400 }) }
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidAlarmContext(); return value as Record<string, any> }
function pick<S extends Record<string, string>>(value: unknown, shape: S): Snapshot<S> {
  const row = object(value), result: Record<string, unknown> = {}
  for (const [key, type] of Object.entries(shape)) {
    const v = row[key]
    if (!(type === 'id' ? Number.isSafeInteger(v) && v > 0 : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : type === 'text?' ? v === null || typeof v === 'string' : typeof v === 'string')) return invalidAlarmContext()
    result[key] = v
  }
  return Object.freeze(result) as Snapshot<S>
}
function only(row: Record<string, any>, keys: readonly string[]) { if (Object.keys(row).some(key => !keys.includes(key))) return invalidAlarmContext() }
export function captureAlarmContext(point: unknown, group: unknown, device: unknown): AlarmContext {
  const p = pick(point, pointShape), g = pick(group, groupShape), rawGroup = object(group), d = object(device)
  if (p.groupId !== g.id || p.objectId !== d.id || !Number.isSafeInteger(d.id) || d.id < 1 || rawGroup.objectId !== undefined && rawGroup.objectId !== d.id || !['master', 'slave'].includes(d.mode) || !['tcp', 'rtu'].includes(d.transport)) return invalidAlarmContext()
  // Matches the rule engine: group slave for master mode; device slave for slave memory.
  const slaveId = d.mode === 'slave' ? d.slaveId : rawGroup.slaveId
  if (!Number.isInteger(slaveId) || slaveId < 0 || slaveId > 255) return invalidAlarmContext()
  const connection = d.transport === 'tcp' ? pick(d, tcpShape) : pick(d, rtuShape)
  return Object.freeze({ version: 1, point: p, group: g, device: Object.freeze({ id: d.id, mode: d.mode, slaveId, connection }) })
}
export function parseAlarmContext(value: unknown): AlarmContext {
  const row = object(value), point = object(row.point), group = object(row.group), device = object(row.device), connection = object(device.connection)
  only(row, ['version', 'point', 'group', 'device']); only(point, Object.keys(pointShape)); only(group, Object.keys(groupShape)); only(device, ['id', 'mode', 'slaveId', 'connection'])
  if (row.version !== 1) return invalidAlarmContext()
  only(connection, connection.transport === 'tcp' ? Object.keys(tcpShape) : Object.keys(rtuShape))
  return captureAlarmContext(point, { ...group, slaveId: device.slaveId }, { id: device.id, mode: device.mode, slaveId: device.slaveId, ...connection })
}
export function alarmContextMatches(a: AlarmContext, b: AlarmContext) { return JSON.stringify(parseAlarmContext(a)) === JSON.stringify(parseAlarmContext(b)) }
