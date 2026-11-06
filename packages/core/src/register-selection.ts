import { areaForFunction, type ModbusFunctionCode } from './protocol.ts'
import { validSlaveId } from './sample-source.ts'

interface SourceRegister { id: number; groupId?: number; alias?: string | null; functionCode: number; startAddress: number; dataType: string; slaveId?: number }
export interface RegisterSelector { area: string; address: number; slaveId?: number; registerId?: number }
export interface RegisterSelectionError {
  error: string
  code: 'REGISTER_SELECTOR_INVALID' | 'REGISTER_NOT_FOUND' | 'REGISTER_AMBIGUOUS'
  candidates: Array<{ register_id: number; group_id: number | null; slave_id: number | null; alias: string | null; data_type: string }>
}

/** Registers must already be scoped to the requested device and bound to configured sources. */
export function selectSourceRegister<T extends SourceRegister>(registers: T[], selector: RegisterSelector): { register: T } | RegisterSelectionError {
  if (!['coil', 'discrete-input', 'holding-register', 'input-register'].includes(selector.area) || !Number.isInteger(selector.address) || selector.address < 0 || selector.address > 65535 ||
    selector.slaveId !== undefined && !validSlaveId(selector.slaveId) ||
    selector.registerId !== undefined && (!Number.isSafeInteger(selector.registerId) || selector.registerId < 1)) {
    return { error: '点位选择参数无效，请使用有效的数据区/地址、整数 slave_id（0–255）和正安全整数 register_id。', code: 'REGISTER_SELECTOR_INVALID', candidates: [] }
  }
  const located = registers.filter(r => r.startAddress === selector.address && areaForFunction(r.functionCode as ModbusFunctionCode) === selector.area)
  const matching = located.filter(r => (selector.slaveId === undefined || r.slaveId === selector.slaveId) && (selector.registerId === undefined || r.id === selector.registerId))
  if (matching.length === 1) return { register: matching[0] }
  const candidates = (matching.length ? matching : located).map(r => ({ register_id: r.id, group_id: r.groupId ?? null, slave_id: validSlaveId(r.slaveId) ? r.slaveId : null, alias: r.alias ?? null, data_type: r.dataType }))
    .sort((a, b) => (a.slave_id ?? 256) - (b.slave_id ?? 256) || a.register_id - b.register_id)
  return matching.length ? { error: '地址不唯一，请从 candidates 选择 slave_id 或 register_id；同从站多点位时需要 register_id。', code: 'REGISTER_AMBIGUOUS', candidates } :
    { error: '所选设备/数据区/地址下没有匹配点位，请核对 slave_id 和 register_id；不会回退到其他来源。', code: 'REGISTER_NOT_FOUND', candidates }
}
