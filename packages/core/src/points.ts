import type { ModbusArea } from './protocol.ts'

/** 点表里的一行（导入语义用）。 */
export interface PointRow {
  area: ModbusArea
  address: number
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

export type PointField = 'alias' | 'address' | 'area' | 'dataType' | 'unit' | 'factor' | 'offset' | 'enum' | 'ignore'

export function guessField(header: string): PointField {
  const t = (header ?? '').trim().toUpperCase()
  if (!t) return 'ignore'
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
export function smartParseTable(rows: string[][]): { points: PointRow[]; report: SmartImportReport } {
  const report: SmartImportReport = { total: 0, parsed: 0, skipped: 0, columns: {}, errors: [] }
  if (rows.length === 0) return { points: [], report }
  const header = rows[0]
  const mapping = header.map((h) => guessField(h))
  header.forEach((h, i) => { if (mapping[i] !== 'ignore') report.columns[mapping[i]] = h.trim() })

  const points: PointRow[] = []
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
    const areaRaw = get('area')
    const area = (areaRaw ? parseSmartZone(areaRaw) : null) ?? addrInfo.area ?? 'holding-register'
    const factor = Number(get('factor'))
    const offset = Number(get('offset'))
    points.push({
      area,
      address: addrInfo.address,
      alias: get('alias') || null,
      dataType: parseSmartDataType(get('dataType')) ?? 'int16',
      unit: get('unit') || null,
      factor: Number.isFinite(factor) ? factor : 1,
      offset: Number.isFinite(offset) ? offset : 0,
      enumMap: parseEnumNotation(get('enum')),
    })
    report.parsed++
  }
  return { points, report }
}

/** 智能解析 CSV 点表（返回点位 + 报告）。 */
export function smartParseCsv(text: string): { points: PointRow[]; report: SmartImportReport } {
  return smartParseTable(parseCsv(text))
}

/** 兼容旧接口：固定表头 CSV → 点位（内部也走智能识别）。 */
export function parsePointCsv(text: string): PointRow[] {
  return smartParseTable(parseCsv(text)).points
}
