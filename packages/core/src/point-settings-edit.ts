import { DATA_TYPES } from './codec.ts'

const pointShape = { id: 'id', objectId: 'id', groupId: 'id', alias: 'text?', functionCode: 'number', startAddress: 'number', dataType: 'text', unit: 'text?', factor: 'number', offset: 'number', enumJson: 'text?', decimalPlaces: 'number?' } as const
const groupShape = { id: 'id', slaveId: 'number', functionCode: 'number', startAddress: 'number', quantity: 'number', mode: 'text' } as const
const deviceShape = { id: 'id', mode: 'text', slaveId: 'number', transport: 'text', ip: 'text', port: 'number', serialPath: 'text?', baudRate: 'number', parity: 'text', stopBits: 'number', dataBits: 'number', flowControl: 'text' } as const
type ShapeValue<T> = T extends 'id' | 'number' ? number : T extends 'number?' ? number | null : T extends 'text?' ? string | null : string
type Snapshot<S> = { readonly [K in keyof S]: ShapeValue<S[K]> }
export interface PointEditBaseline { readonly point: Snapshot<typeof pointShape>; readonly group: Snapshot<typeof groupShape>; readonly device: Snapshot<typeof deviceShape> }
export type PointEditChanges = Partial<Pick<PointEditBaseline['point'], 'dataType' | 'unit' | 'factor' | 'offset' | 'enumJson' | 'decimalPlaces'>>
const editable = ['dataType', 'unit', 'factor', 'offset', 'enumJson', 'decimalPlaces'] as const
const identity = ['id', 'objectId', 'groupId', 'alias', 'functionCode', 'startAddress', 'dataType'] as const
const invalid = (): never => { throw Object.assign(new Error('点位设置保存参数无效，请刷新配置后重新编辑。'), { statusCode: 400 }) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function snapshot<S extends Record<string, string>>(input: unknown, shape: S): Snapshot<S> {
  const source = object(input), result: Record<string, unknown> = {}
  for (const [key, type] of Object.entries(shape)) {
    // Older frontend point metadata has optional decimalPlaces, whose stored default is NULL.
    const value = key === 'decimalPlaces' && source[key] === undefined ? null : source[key]
    const valid = type.endsWith('?') && value === null || type.startsWith('text') && typeof value === 'string' || type.startsWith('number') && typeof value === 'number' && Number.isFinite(value) || type === 'id' && typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    if (!valid) return invalid()
    result[key] = value
  }
  return Object.freeze(result) as Snapshot<S>
}
/** A frozen, explicit snapshot: never silently refresh the expected values while a draft is open. */
export function capturePointEditBaseline(point: unknown, group: unknown, device: unknown): PointEditBaseline {
  const result = { point: snapshot(point, pointShape), group: snapshot(group, groupShape), device: snapshot(device, deviceShape) }
  if (result.point.groupId !== result.group.id || result.point.objectId !== result.device.id) return invalid()
  return Object.freeze(result)
}
export function parsePointEditRequest(value: unknown): { expected: PointEditBaseline; changes: PointEditChanges } {
  const body = object(value), raw = object(body.expected), changes = object(body.changes)
  if (Object.keys(body).some(key => !['expected', 'changes'].includes(key)) || Object.keys(raw).some(key => !['point', 'group', 'device'].includes(key))) return invalid()
  const expected = capturePointEditBaseline(raw.point, raw.group, raw.device)
  const entries = Object.entries(changes)
  if (!entries.length || entries.some(([key]) => !(editable as readonly string[]).includes(key))) return invalid()
  const result: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (key === 'dataType' ? typeof value !== 'string' || value !== expected.point.dataType && !(DATA_TYPES as readonly string[]).includes(value)
      : key === 'factor' || key === 'offset' ? typeof value !== 'number' || !Number.isFinite(value)
      : key === 'decimalPlaces' ? value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8)
      : value !== null && typeof value !== 'string') return invalid()
    result[key] = value
  }
  return { expected, changes: Object.freeze(result) as PointEditChanges }
}
/** Compare identity/context and fields being written. Omitted enum updates retain concurrent changes. */
export function pointEditMatches(current: PointEditBaseline, expected: PointEditBaseline, changes: PointEditChanges): boolean {
  const keys = new Set<keyof PointEditBaseline['point']>([...identity, ...Object.keys(changes) as (keyof PointEditChanges)[]])
  return [...keys].every(key => current.point[key] === expected.point[key]) &&
    (Object.keys(groupShape) as (keyof typeof groupShape)[]).every(key => current.group[key] === expected.group[key]) &&
    (Object.keys(deviceShape) as (keyof typeof deviceShape)[]).every(key => current.device[key] === expected.device[key])
}
