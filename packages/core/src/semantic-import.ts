import { DATA_TYPES, baseType, isLittleEndian } from './codec.ts'
import { functionCodeForArea, type ModbusArea } from './protocol.ts'

export interface SemanticPointUpdate {
  functionCode: number; address: number; slaveId?: number; registerId?: number
  alias?: string | null; dataType?: string; unit?: string | null; factor?: number; offset?: number; enumMap?: Record<string, string> | null
}
const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }) }

/** API/MCP/parser normalization. Missing fields stay missing; explicit null clears only nullable fields. */
export function normalizeSemanticPoint(value: unknown): SemanticPointUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('点表行必须是对象')
  const row = value as Record<string, any>
  const pair = (snake: string, camel: string) => {
    if (Object.hasOwn(row, snake) && Object.hasOwn(row, camel) && row[snake] !== row[camel]) invalid('点表字段冲突：' + snake + '/' + camel)
    return Object.hasOwn(row, snake) ? row[snake] : row[camel]
  }
  return { functionCode: functionCodeForArea(row.area as ModbusArea), address: row.address, slaveId: pair('slave_id', 'slaveId'), registerId: pair('register_id', 'registerId'),
    alias: row.alias, dataType: pair('data_type', 'dataType'), unit: row.unit, factor: row.factor, offset: row.offset,
    enumMap: Object.hasOwn(row, 'enum') ? row.enum : row.enumMap }
}

export function semanticPointFields(point: SemanticPointUpdate): { fields: Record<string, unknown> } | { error: string } {
  const fields: Record<string, unknown> = {}
  if (point.alias != null) { if (typeof point.alias !== 'string') return { error: 'alias必须为文本' }; fields.alias = point.alias }
  if (point.dataType !== undefined) {
    if (typeof point.dataType !== 'string' || !(DATA_TYPES as readonly string[]).includes(baseType(point.dataType) + (isLittleEndian(point.dataType) ? '-LE' : ''))) return { error: 'dataType不受现有编解码器支持' }
    fields.dataType = point.dataType
  }
  if (point.unit !== undefined) { if (point.unit !== null && typeof point.unit !== 'string') return { error: 'unit必须为文本或null' }; fields.unit = point.unit }
  for (const key of ['factor', 'offset'] as const) if (point[key] !== undefined) {
    if (typeof point[key] !== 'number' || !Number.isFinite(point[key])) return { error: key + '必须为有限数值' }
    fields[key] = point[key]
  }
  if (point.enumMap !== undefined) {
    if (point.enumMap !== null && (typeof point.enumMap !== 'object' || Array.isArray(point.enumMap) || Object.values(point.enumMap).some(v => typeof v !== 'string'))) return { error: 'enum必须为字符串映射或null' }
    fields.enumJson = point.enumMap === null ? null : JSON.stringify(point.enumMap)
  }
  return { fields }
}
