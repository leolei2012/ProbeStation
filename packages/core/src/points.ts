import { areaForFunction, type ModbusArea, type ModbusFunctionCode } from './protocol.ts'
import { DATA_TYPES } from './codec.ts'

/** 点表里的一行（导入语义用）。 */
export interface PointRow {
  area: ModbusArea
  address: number
  slaveId?: number
  registerId?: number
  alias?: string | null
  dataType?: string
  unit?: string | null
  factor?: number
  offset?: number
  enumMap?: Record<string, string> | null
}

/** 智能导入结果报告。 */
export interface SmartImportReport {
  total: number
  parsed: number
  skipped: number
  columns: Record<string, string>
  errors: string[]
}

/** 把 enum 紧凑记法 "10:CONST_SPEED;11:CONST_TORQUE" 解析成映射。 */
export function parseEnumNotation(text: string | null | undefined): Record<string, string> | null {
  if (!text || !text.trim()) return null
  const out: Record<string, string> = {}
  for (const part of text.split(';')) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 极简 CSV 解析：支持双引号字段与 "" 转义；不支持引号内换行。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

function containsAny(t: string, ...keywords: string[]): boolean {
  return keywords.some((k) => t.includes(k))
}

// ── 列识别（表头关键词模糊匹配） ───────────────────────────

export type PointField = 'alias' | 'address' | 'area' | 'dataType' | 'unit' | 'factor' | 'offset' | 'enum' | 'slaveId' | 'registerId' | 'ignore'

export function guessField(header: string): PointField {
  const t = (header ?? '').trim().toUpperCase()
  if (!t) return 'ignore'
  const identity = t.replace(/[\s_-]/g, '')
  if (['SLAVEID', 'SLAVEADDRESS', 'UNITID', '从站', '从站号', '从站ID', '从站编号', '从站地址'].includes(identity)) return 'slaveId'
  if (['REGISTERID', 'POINTID', '点位ID', '寄存器ID'].includes(identity)) return 'registerId'
  if (containsAny(t, 'NAME', 'TAG', '变量', '位号', '名称', '标识', '别名', 'ALIAS')) return 'alias'
  if (containsAny(t, 'ADDR', 'REG', '地址', '寄存器', 'POINT')) return 'address'
  if (containsAny(t, 'ZONE', 'AREA', '存储区', '区域', 'FC', 'FUNCTION')) return 'area'
  if (containsAny(t, 'TYPE', 'FMT', 'FORMAT', '类型', '格式', 'DATATYPE', 'DATA_TYPE')) return 'dataType'
  if (containsAny(t, 'UNIT', '单位', '量纲')) return 'unit'
  if (containsAny(t, 'FACTOR', 'SCALE', '系数', '缩放', '倍率')) return 'factor'
  if (containsAny(t, 'OFFSET', '偏移')) return 'offset'
  if (containsAny(t, 'ENUM', '枚举', '状态含义', '状态', '含义')) return 'enum'
  return 'ignore'
}

// ── 地址启发式：兼容 0x64 / 64H / 40001（PLC 逻辑地址） / %MW100 ──

export function parseSmartAddress(raw: string | null | undefined): { area?: ModbusArea; address: number } | null {
  if (!raw || !raw.trim()) return null
  let s = raw.trim().toUpperCase()
  if (s.startsWith('0X') || s.endsWith('H')) {
    s = s.replace(/^0X/, '').replace(/H$/, '')
    const n = parseInt(s, 16)
    return Number.isFinite(n) ? { address: n } : null
  }
  if (/^\d{5,6}$/.test(s)) {
    const prefix = s[0]
    const offset = parseInt(s.slice(1), 10)
    const address = offset > 0 ? offset - 1 : 0
    switch (prefix) {
      case '0': return { area: 'coil', address }
      case '1': return { area: 'discrete-input', address }
      case '3': return { area: 'input-register', address }
      case '4': return { area: 'holding-register', address }
    }
  }
  const m = s.match(/\d+/)
  if (m) {
    const n = parseInt(m[0], 10)
    return Number.isFinite(n) ? { address: n } : null
  }
  return null
}

// ── 数据类型 / 存储区启发式 ─────────────────────────────────

export function parseSmartDataType(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const t = raw.trim().toUpperCase()
  if (containsAny(t, 'Q15', 'Q1.15', 'Q1_15')) return 'q15'
  if (containsAny(t, 'Q31', 'Q1.31', 'Q1_31')) return 'q31'
  if (containsAny(t, 'DINT', 'INT32', 'LONG')) return 'int32'
  if (containsAny(t, 'UDINT', 'UINT32', 'ULONG', 'DWORD')) return 'uint32'
  if (containsAny(t, 'LREAL', 'DOUBLE', '双精度')) return 'float64'
  if (containsAny(t, 'REAL', 'FLOAT', 'SINGLE', '浮点')) return 'float32'
  if (containsAny(t, 'SHORT', 'INTEGER', '16BIT', 'INT16')) return 'int16'
  if (containsAny(t, 'UINT', 'USHORT', 'WORD', 'UNSIGNED', 'UWORD', 'UINT16')) return 'uint16'
  if (containsAny(t, 'BOOL', 'BIT', 'DIGITAL')) return 'uint16'
  if (t === 'HEX') return 'hex16'
  if (t === 'BIN' || t === 'BINARY') return 'bin16'
  return null
}

export function parseSmartZone(raw: string | null | undefined): ModbusArea | null {
  if (!raw || !raw.trim()) return null
  const t = raw.trim().toUpperCase()
  if (/^0?[1-4]$/.test(t)) return areaForFunction(Number(t) as ModbusFunctionCode)
  if (containsAny(t, '0X', 'COIL', 'FC01', 'FC1', 'FC05', 'FC5', 'FC15')) return 'coil'
  if (containsAny(t, '1X', 'FC02', 'FC2') || (t.includes('INPUT') && t.includes('STAT'))) return 'discrete-input'
  if (containsAny(t, '3X', 'AI', 'IR', 'FC04', 'FC4') || (t.includes('INPUT') && t.includes('REG'))) return 'input-register'
  if (containsAny(t, '4X', 'HOLD', 'HR', 'AO', 'FC03', 'FC3', 'FC06', 'FC16')) return 'holding-register'
  if (t === 'RW' || t === 'R/W') return 'holding-register'
  if (t === 'RO') return 'input-register'
  return null
}

// ── 智能表格解析 ────────────────────────────────────────────

/** 把二维表（表头 + 数据行）智能解析成点表。 */
export function smartParseTable(rows: string[][], options: { partial?: boolean } = {}): { points: PointRow[]; report: SmartImportReport } {
  const report: SmartImportReport = { total: 0, parsed: 0, skipped: 0, columns: {}, errors: [] }
  if (rows.length === 0) return { points: [], report }
  const header = rows[0]
  const mapping = header.map((h) => guessField(h))
  header.forEach((h, i) => { if (mapping[i] !== 'ignore') report.columns[mapping[i]] = h.trim() })

  const points: PointRow[] = []
  const duplicated = ['slaveId', 'registerId', ...(options.partial ? ['address', 'area'] : [])].filter(field => mapping.filter(value => value === field).length > 1)
  if (duplicated.length) {
    report.total = rows.slice(1).filter(row => row.some(c => c.trim())).length; report.skipped = report.total
    report.errors.push('duplicate identity columns: ' + duplicated.join(', ')); return { points, report }
  }
  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri]
    if (row.every((c) => !c.trim())) continue
    report.total++
    const get = (field: PointField): string => {
      const i = mapping.indexOf(field)
      return i >= 0 && i < row.length ? row[i].trim() : ''
    }
    const addrRaw = get('address')
    if (!addrRaw) { report.skipped++; report.errors.push('row ' + ri + ': missing address'); continue }
    const addrInfo = parseSmartAddress(addrRaw)
    if (!addrInfo) { report.skipped++; report.errors.push('row ' + ri + ': cannot parse address "' + addrRaw + '"'); continue }
    const areaRaw = get('area'), explicitArea = areaRaw ? parseSmartZone(areaRaw) : null
    if (options.partial && areaRaw && !explicitArea) { report.skipped++; report.errors.push('row ' + ri + ': invalid area'); continue }
    const area = explicitArea ?? addrInfo.area ?? 'holding-register'
    const identities: { slaveId?: number; registerId?: number } = {}
    let invalidIdentity = false
    for (const field of ['slaveId', 'registerId'] as const) {
      const raw = get(field)
      if (!raw) continue
      const value = Number(raw), max = field === 'slaveId' ? 255 : Number.MAX_SAFE_INTEGER, min = field === 'slaveId' ? 0 : 1
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) { report.errors.push('row ' + ri + ': invalid ' + field); invalidIdentity = true }
      else identities[field] = value
    }
    if (invalidIdentity) { report.skipped++; continue }
    const rawType = get('dataType'), canonical = rawType.toLowerCase().replace(/[-_]le$/, '-LE')
    const dtype = (DATA_TYPES as readonly string[]).includes(canonical) ? canonical : parseSmartDataType(rawType)
    if (options.partial && rawType && !dtype && rawType.toUpperCase() !== 'INT') { report.skipped++; report.errors.push('row ' + ri + ': invalid dataType'); continue }
    const factor = Number(get('factor')), offset = Number(get('offset'))
    const has = (field: PointField) => !options.partial || mapping.includes(field)
    points.push({ area, address: addrInfo.address, ...identities,
      ...(has('alias') ? { alias: get('alias') || null } : {}),
      ...(has('dataType') ? { dataType: dtype ?? 'int16' } : {}),
      ...(has('unit') ? { unit: get('unit') || null } : {}),
      ...(has('factor') ? { factor: options.partial ? factor : Number.isFinite(factor) ? factor : 1 } : {}),
      ...(has('offset') ? { offset: options.partial ? offset : Number.isFinite(offset) ? offset : 0 } : {}),
      ...(has('enum') ? { enumMap: parseEnumNotation(get('enum')) } : {}),
    })
    report.parsed++
  }
  return { points, report }
}

/** 智能解析 CSV 点表（返回点位 + 报告）。 */
export function smartParseCsv(text: string, options: { partial?: boolean } = {}): { points: PointRow[]; report: SmartImportReport } {
  return smartParseTable(parseCsv(text), options)
}

/** 兼容旧接口：固定表头 CSV → 点位（内部也走智能识别）。 */
export function parsePointCsv(text: string): PointRow[] {
  return smartParseTable(parseCsv(text)).points
}
