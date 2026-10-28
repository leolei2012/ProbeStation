import { DATA_TYPES, registerWidth } from '../../core/src/codec.ts'
import { ALARM_OPERATORS } from '../../core/src/alarm.ts'
import type { DeviceRecord, GroupRecord, RegisterRecord, RuleRecord } from './index.ts'
import { parseRegisterQuantity } from './register-quantity.ts'

export interface ConfigBackup {
  format: 'probestation-config'; version: 1; createdAt: string
  devices: DeviceRecord[]; groups: GroupRecord[]; registers: RegisterRecord[]; rules: RuleRecord[]
}
const invalid = (field: string): never => { throw Object.assign(new Error('备份文件无效：' + field), { statusCode: 400 }) }
const text = (v: unknown, field: string, nullable = false) => { if (!(nullable && v === null) && typeof v !== 'string') invalid(field) }
const integer = (v: unknown, min: number, max: number, field: string) => { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid(field) }
const finite = (v: unknown, field: string) => { if (typeof v !== 'number' || !Number.isFinite(v)) invalid(field) }

/** Versioned human-readable data only: no credentials, files, SQL or executable commands. */
export function parseConfigBackup(value: unknown): ConfigBackup {
  const b = value as ConfigBackup
  if (!b || b.format !== 'probestation-config' || b.version !== 1 || !Number.isFinite(Date.parse(b.createdAt))) invalid('格式或版本不支持')
  for (const key of ['devices', 'groups', 'registers', 'rules'] as const) {
    if (!Array.isArray(b[key])) invalid(key)
    const ids = new Set<number>()
    for (const r of b[key]) {
      if (!r || typeof r !== 'object') invalid(key)
      integer(r.id, 1, Number.MAX_SAFE_INTEGER, key + '.id')
      if (ids.has(r.id)) invalid(key + ' ID 重复')
      ids.add(r.id)
    }
  }
  const devices = new Map(b.devices.map(d => [d.id, d])), groups = new Map(b.groups.map(g => [g.id, g])), regs = new Map(b.registers.map(r => [r.id, r]))
  for (const d of b.devices) {
    text(d.name, '设备名称'); if (!d.name.trim()) invalid('设备名称为空')
    text(d.ip, '设备地址'); text(d.serialPath, '串口', true)
    if (!['master', 'slave'].includes(d.mode) || !['tcp', 'rtu'].includes(d.transport)) invalid('设备角色或传输方式')
    integer(d.isActive, 0, 1, '设备启用状态')
    integer(d.port, 1, 65535, '端口'); integer(d.slaveId, 0, 247, '从站地址')
    integer(d.baudRate, 300, 4000000, '波特率'); integer(d.dataBits, 5, 8, '数据位')
    if (!['none', 'even', 'odd'].includes(d.parity) || ![1, 2].includes(d.stopBits) || !['none', 'rtscts', 'xonxoff'].includes(d.flowControl)) invalid('串口参数')
    integer(d.pollIntervalMs, 1, Number.MAX_SAFE_INTEGER, '采样间隔'); integer(d.timeoutMs, 1, Number.MAX_SAFE_INTEGER, '超时时间')
    if (d.dataRetainSeconds !== null) integer(d.dataRetainSeconds, 0, Number.MAX_SAFE_INTEGER, '保留时长')
  }
  for (const g of b.groups) {
    if (!devices.has(g.objectId)) invalid('分组引用不存在的设备')
    text(g.name, '分组名称'); text(g.mode, '分组模式')
    if (![1, 2, 3, 4].includes(g.functionCode)) invalid('功能码')
    integer(g.startAddress, 0, 65535, '分组地址'); integer(g.quantity, 1, 65536 - g.startAddress, '分组长度')
    integer(g.slaveId, 0, 247, '分组从站地址'); integer(g.isActive, 0, 1, '分组启用状态')
  }
  for (const r of b.registers) {
    const g = groups.get(r.groupId)
    if (!g) throw Object.assign(new Error('备份文件无效：点位分组不存在'), { statusCode: 400 })
    if (g.objectId !== r.objectId || g.functionCode !== r.functionCode) invalid('点位与分组或设备关系不一致')
    if (!(DATA_TYPES as readonly string[]).includes(r.dataType)) invalid('点位类型')
    integer(r.startAddress, g.startAddress, g.startAddress + g.quantity - 1, '点位地址')
    if (Object.hasOwn(r, 'quantity')) parseRegisterQuantity(r.quantity)
    // Existing groups can contain trailing covered placeholder rows; preserve them in backups.
    if (r.startAddress + registerWidth(r.dataType) > 65536) invalid('点位超出地址空间')
    text(r.alias, '点位名称', true); text(r.unit, '工程单位', true)
    finite(r.factor, '系数'); finite(r.offset, '偏移')
    if (r.decimalPlaces !== null) integer(r.decimalPlaces, 0, 8, '物理值小数位数')
    if (r.enumJson !== null) {
      text(r.enumJson, '枚举')
      let enums: any; try { enums = JSON.parse(r.enumJson) } catch { invalid('枚举 JSON') }
      if (!enums || typeof enums !== 'object' || Array.isArray(enums) || Object.values(enums).some(v => typeof v !== 'string')) invalid('枚举映射')
    }
  }
  for (const r of b.rules) {
    if (!regs.has(r.registerId)) invalid('告警引用不存在的点位')
    if (!(ALARM_OPERATORS as readonly string[]).includes(r.operator)) invalid('告警运算符')
    finite(r.threshold, '告警阈值'); text(r.message, '告警提示', true)
  }
  // Old v1 backups may omit metadata. Keep caller-owned input intact (even frozen input).
  return { ...b, registers: b.registers.map(r => Object.hasOwn(r, 'quantity') ? r : { ...r, quantity: 1 }) }
}
