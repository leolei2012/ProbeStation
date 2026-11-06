import { DATA_TYPES, baseType, isLittleEndian, registerWidth } from './codec.ts'
import { areaForFunction, validateModbusRequest, type ModbusArea, type ModbusFunctionCode } from './protocol.ts'

type Row = Record<string, any>
export interface PointDiagnosticIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  path?: string
  entityId?: number
  objectId?: number
  groupId?: number
  registerIds?: number[]
  slaveId?: number
  area?: ModbusArea
}
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const address = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 65535
const readFc = (v: unknown): v is ModbusFunctionCode => [1, 2, 3, 4].includes(v as number)
const record = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const bucket = <T>(map: Map<string, T[]>, key: string, value: T) => { const rows = map.get(key) ?? []; rows.push(value); map.set(key, rows) }

export class PointTableInputError extends Error {}

/** Structural diagnostics only. Never normalize caller-owned records, repair configuration or read hardware. */
export function diagnosePointTable(input: unknown) {
  if (!record(input) || ['devices', 'groups', 'registers'].some(key => !Array.isArray(input[key]) || !input[key].every(record))) throw new PointTableInputError('点表需要 devices/groups/registers 对象数组；可使用 JSON 配置备份。')
  const { devices, groups, registers } = input as { devices: Row[]; groups: Row[]; registers: Row[] }
  const issues: PointDiagnosticIssue[] = []
  const add = (severity: PointDiagnosticIssue['severity'], code: string, message: string, refs: Omit<PointDiagnosticIssue, 'severity' | 'code' | 'message'> = {}) => issues.push({ severity, code, message, ...refs })
  const unique = (rows: Row[], name: string) => {
    const seen = new Map<number, Row[]>(), result = new Map<number, Row>()
    rows.forEach((row, i) => {
      if (!id(row.id)) add('error', 'INVALID_ID', '配置记录 ID 必须为正安全整数。', { path: `${name}[${i}]` })
      else { const same = seen.get(row.id) ?? []; same.push(row); seen.set(row.id, same) }
    })
    for (const [key, rows] of seen) {
      if (rows.length > 1) add('error', 'DUPLICATE_ID', '同类配置 ID 重复，无法唯一引用。', { path: name, entityId: key })
      else result.set(key, rows[0])
    }
    return result
  }
  const deviceById = unique(devices, 'devices'), groupById = unique(groups, 'groups'), registerById = unique(registers, 'registers')
  for (const [i, d] of devices.entries()) {
    if (d.mode == null) add('warning', 'DEFAULT_DEVICE_MODE', '缺少角色，现有代码按主站处理；请确认配置。', { path: `devices[${i}]` })
    else if (!['master', 'slave'].includes(d.mode)) add('error', 'INVALID_DEVICE_MODE', '设备角色不是 master/slave。', { path: `devices[${i}]` })
    if (d.mode === 'slave' && (!Number.isInteger(d.slaveId ?? 1) || (d.slaveId ?? 1) < 1 || (d.slaveId ?? 1) > 247)) add('error', 'INVALID_LOCAL_SLAVE', '本地从站编号不符合现有 1–247 校验。', { path: `devices[${i}]` })
  }
  type Group = { row: Row; area?: ModbusArea; end?: number; source?: number; local: boolean }
  const groupState = new Map<number, Group>()
  groups.forEach((g, i) => {
    const refs = { path: `groups[${i}]`, ...(id(g.objectId) ? { objectId: g.objectId } : {}), ...(id(g.id) ? { groupId: g.id } : {}) }
    const device = deviceById.get(g.objectId), local = device?.mode === 'slave'
    if (!device) add('error', 'GROUP_DEVICE_MISSING', '分组的设备不存在或 ID 不唯一。', refs)
    const area = readFc(g.functionCode) ? areaForFunction(g.functionCode) : undefined
    if (!area) add('error', 'INVALID_GROUP_FUNCTION', '采集分组只支持读取功能码 FC01/02/03/04。', refs)
    const rangeValid = address(g.startAddress) && Number.isInteger(g.quantity) && g.quantity >= 1 && g.quantity <= 65536 - g.startAddress
    if (!rangeValid) add('error', 'INVALID_GROUP_RANGE', '分组范围必须是 0–65535 内的正长度整数区间。', refs)
    const rawSource = local ? device?.slaveId : g.slaveId, source = rawSource ?? 1
    if (device && rawSource == null) add('warning', 'DEFAULT_SLAVE_ID', '缺少从站编号，运行代码会默认 1；这里只提示，不写入或补全身份。', refs)
    let sourceValid = !!device && (device.mode == null || device.mode === 'master' || device.mode === 'slave') && Number.isInteger(source) && source >= 1 && source <= 247
    if (device && !local && area && rangeValid) {
      // A large group is split by the poller. Validate only a legal-sized chunk, not the whole group against one PDU.
      const errors = validateModbusRequest({ slaveId: source, functionCode: g.functionCode, startAddress: g.startAddress, quantity: Math.min(g.quantity, g.functionCode <= 2 ? 2000 : 125) })
      if (errors.length) { add('error', 'INVALID_GROUP_REQUEST', '分组请求不符合现有协议校验：' + errors.join('; '), refs); sourceValid = false }
    }
    if (groupById.get(g.id) === g) groupState.set(g.id, { row: g, area, end: rangeValid ? g.startAddress + g.quantity : undefined, source: sourceValid ? source : undefined, local })
  })
  type Point = { row: Row; group: Group; path: string; width: number; end: number; canonical: string; covered?: boolean; placeholder?: boolean }
  const byGroup = new Map<string, Point[]>(), starts = new Map<string, Point[]>(), imports = new Map<string, Point[]>()
  registers.forEach((r, i) => {
    const refs = { path: `registers[${i}]`, ...(id(r.objectId) ? { objectId: r.objectId } : {}), ...(id(r.groupId) ? { groupId: r.groupId } : {}), ...(id(r.id) ? { registerIds: [r.id] } : {}) }
    const group = groupState.get(r.groupId), g = group?.row
    if (!g) add('error', 'REGISTER_GROUP_MISSING', '点位分组不存在或 ID 不唯一。', refs)
    else {
      if (r.objectId !== g.objectId) add('error', 'REGISTER_DEVICE_MISMATCH', '点位与所属分组的设备不一致。', refs)
      if (r.functionCode !== g.functionCode) add('error', 'REGISTER_FUNCTION_MISMATCH', '点位功能码与所属分组不一致。', refs)
    }
    const canonical = typeof r.dataType === 'string' ? baseType(r.dataType) + (isLittleEndian(r.dataType) ? '-LE' : '') : ''
    const typeValid = (DATA_TYPES as readonly string[]).includes(canonical)
    if (!typeValid) add('error', 'UNSUPPORTED_DATA_TYPE', '点位数据类型不受现有编解码器支持，不能按未知类型推断字宽。', refs)
    else if (r.dataType !== canonical) add('warning', 'LEGACY_TYPE_SPELLING', '该旧类型拼写可被编解码器识别，但备份校验要求规范的 -LE 拼写；未修改原值。', refs)
    if (Object.hasOwn(r, 'quantity') && (!Number.isSafeInteger(r.quantity) || r.quantity < 1)) add('error', 'INVALID_QUANTITY_METADATA', '显式 quantity 元数据须为正安全整数；它不决定 dtype 的实际字宽。', refs)
    if (!address(r.startAddress)) { add('error', 'INVALID_REGISTER_ADDRESS', '点位地址必须为 0–65535 整数。', refs); return }
    if (!typeValid) return
    const width = registerWidth(r.dataType), end = r.startAddress + width
    if (end > 65536) { add('error', 'REGISTER_ADDRESS_OVERFLOW', '按 dtype 字宽计算后超出地址 65535。quantity 元数据不决定字宽。', refs); return }
    if (!group || r.objectId !== g!.objectId || r.functionCode !== g!.functionCode || registerById.get(r.id) !== r) return
    if (group.end !== undefined && (r.startAddress < g!.startAddress || r.startAddress >= group.end)) { add('error', 'REGISTER_START_OUTSIDE_GROUP', '点位起始地址不在所属分组范围内。', refs); return }
    const point: Point = { row: r, group, width, end, canonical, path: refs.path }
    bucket(byGroup, String(r.groupId), point)
    if (group.area) bucket(imports, JSON.stringify([r.objectId, r.functionCode, r.startAddress]), point)
    if (group.area && group.source !== undefined) bucket(starts, JSON.stringify([r.objectId, group.source, group.area, r.startAddress]), point)
  })
  let coveredPlaceholders = 0
  const effective = new Map<string, Point[]>()
  const refsFor = (points: Point[]) => ({ objectId: points[0].row.objectId as number, registerIds: points.map(p => p.row.id as number), ...(points[0].group.area ? { area: points[0].group.area } : {}), ...(points[0].group.source !== undefined ? { slaveId: points[0].group.source } : {}) })
  for (const points of byGroup.values()) {
    let coveredEnd = -1, previousStart = -1
    for (const p of [...points].sort((a, b) => a.row.startAddress - b.row.startAddress)) {
      const r = p.row, end = p.group.end
      p.covered = r.startAddress < coveredEnd
      p.placeholder = p.covered && r.startAddress > previousStart && p.canonical === 'int16' && !r.alias && !r.unit && (r.factor ?? 1) === 1 && (r.offset ?? 0) === 0 && r.enumJson == null && r.decimalPlaces == null
      if (p.placeholder) coveredPlaceholders++
      else if (p.covered && r.startAddress !== previousStart) add('warning', 'COVERED_DEFINITION', '该有语义点位位于前面多字点位的覆盖范围；常规显示可能覆盖它，请确认是否有意。', { ...refsFor([p]), groupId: r.groupId, path: p.path })
      if (end !== undefined && p.end > end) add(p.covered ? 'warning' : 'error', p.covered ? 'COVERED_WIDTH_OUTSIDE_GROUP' : 'REGISTER_WIDTH_OUTSIDE_GROUP', '按 dtype 计算的完整字宽超出分组末地址；未扩组或删除点位。', { ...refsFor([p]), groupId: r.groupId, path: p.path })
      if (!p.covered && end !== undefined && p.end <= end) {
        coveredEnd = p.end; previousStart = r.startAddress
        if (p.group.area && p.group.source !== undefined) bucket(effective, JSON.stringify([r.objectId, p.group.source, p.group.area]), p)
      }
    }
  }
  for (const points of starts.values()) if (points.length > 1) {
    const definitions = new Set(points.map(p => JSON.stringify([p.canonical, p.row.factor ?? 1, p.row.offset ?? 0, p.row.unit ?? '', p.row.enumJson ?? null, p.row.decimalPlaces ?? null])))
    add('warning', definitions.size === 1 ? 'DUPLICATE_DEFINITION' : 'ALTERNATE_DEFINITION', definitions.size === 1 ? '同一来源/数据区/起始地址存在重复定义；可能有意，未自动删除。' : '同一来源/数据区/起始地址存在不同配置定义；可能是不同视图，请用点位 ID 区分。', refsFor(points))
  }
  for (const points of imports.values()) if (points.length > 1) add('warning', 'IMPORT_MATCH_AMBIGUOUS', '这些点位无法仅由功能码/地址唯一定位；语义导入将跳过歧义行，请明确从站或点位ID。', { objectId: points[0].row.objectId, registerIds: points.map(p => p.row.id) })
  for (const points of effective.values()) {
    let cluster: Point[] = [], end = -1
    const flush = () => {
      if (new Set(cluster.map(p => p.row.groupId)).size > 1 && new Set(cluster.map(p => p.row.startAddress)).size > 1 && !cluster[0].group.local) add('warning', 'OVERLAPPING_GROUP_VALUES', '同来源多组的有效点位字范围部分重叠，各组响应独立，缓存多字可能暂时未知；请核对是否有意。', refsFor(cluster))
    }
    for (const p of [...points].sort((a, b) => a.row.startAddress - b.row.startAddress)) {
      if (cluster.length && p.row.startAddress >= end) { flush(); cluster = [] }
      cluster.push(p); end = Math.max(cluster.length === 1 ? -1 : end, p.end)
    }
    if (cluster.length) flush()
  }
  issues.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || (a.path ?? '').localeCompare(b.path ?? '') || a.code.localeCompare(b.code))
  const errors = issues.filter(i => i.severity === 'error').length, warnings = issues.length - errors
  return { scope: 'point-table-structure' as const, ok: errors === 0, complete: true, summary: { devices: devices.length, groups: groups.length, registers: registers.length, errors, warnings, coveredPlaceholders }, issues }
}

/** Read-only configuration port; deliberately does not export, update or open any database. */
export function diagnoseDevicePoints(cfg: { getObject(id: number): unknown; listGroups(id: number): unknown[]; listRegistersByObject(id: number): unknown[] }, objectId: number) {
  if (!id(objectId)) throw Object.assign(new Error('设备 ID 无效'), { statusCode: 400 })
  const device = cfg.getObject(objectId)
  if (!device) throw Object.assign(new Error('设备不存在'), { statusCode: 404 })
  return diagnosePointTable({ devices: [device], groups: cfg.listGroups(objectId), registers: cfg.listRegistersByObject(objectId) })
}
