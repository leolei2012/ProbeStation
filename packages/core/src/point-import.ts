import { DATA_TYPES, registerWidth } from './codec.ts'
import { validateModbusRequest, type ModbusFunctionCode } from './protocol.ts'

export interface ImportedPointGroup { name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; mode: string }
export interface ImportedPointDefinition { groupIndex: number; alias: string; functionCode: number; startAddress: number; dataType: string }
const invalid = (path: string): never => { throw Object.assign(new Error('点表导入无效：' + path), { statusCode: 400 }) }

/** Groups can span several requests; do not apply one PDU's limit to the whole window. */
export function assertImportedPointGroup(g: ImportedPointGroup, index: number): void {
  const path = `groups[${index}]`
  if (!g || typeof g.name !== 'string' || typeof g.mode !== 'string' || !g.mode.length) invalid(path + ' 名称/模式')
  if (![1, 2, 3, 4].includes(g.functionCode)) invalid(path + ' 仅支持读取窗口 FC01/02/03/04')
  if (!Number.isInteger(g.startAddress) || g.startAddress < 0 || g.startAddress > 65535 || !Number.isInteger(g.quantity) || g.quantity < 1 || g.quantity > 65536 - g.startAddress) invalid(path + ' 地址/长度超出 0–65535')
  const errors = validateModbusRequest({ slaveId: g.slaveId, functionCode: g.functionCode as ModbusFunctionCode, startAddress: g.startAddress, quantity: Math.min(g.quantity, g.functionCode <= 2 ? 2000 : 125) })
  if (errors.length) invalid(path + ' ' + errors.join('; '))
}

/** Explicit source-window identity only; never infer ownership from names or overlapping addresses. */
export function assertImportedPointTable(groups: readonly ImportedPointGroup[], registers: readonly ImportedPointDefinition[]): void {
  if (!Array.isArray(groups) || !Array.isArray(registers)) invalid('分组/点位必须为数组')
  groups.forEach(assertImportedPointGroup)
  registers.forEach((r, i) => {
    const path = `registers[${i}]`
    if (!r || !Number.isInteger(r.groupIndex) || r.groupIndex < 0 || r.groupIndex >= groups.length) invalid(path + ' 缺少有效来源窗口 groupIndex')
    const g = groups[r.groupIndex]
    if (r.functionCode !== g.functionCode || typeof r.alias !== 'string' || !(DATA_TYPES as readonly string[]).includes(r.dataType)) invalid(path + ' 功能码/名称/类型与窗口不一致')
    if (!Number.isInteger(r.startAddress) || r.startAddress < g.startAddress || r.startAddress + registerWidth(r.dataType) > g.startAddress + g.quantity) invalid(path + ' 完整点宽超出来源窗口')
  })
}
