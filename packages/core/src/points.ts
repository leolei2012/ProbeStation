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

function parseAddress(s: string): number {
  const t = s.trim()
  if (t.toLowerCase().startsWith('0x')) return parseInt(t.slice(2), 16)
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
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

/**
 * 解析 CSV 点表。首行表头（大小写不敏感）：
 *   area, address, alias, data_type, unit, factor, offset, enum
 * area 取 coil / discrete-input / holding-register / input-register；
 * address 支持 10 进制或 0x 十六进制；enum 用 "key:label;key:label" 记法。
 */
export function parsePointCsv(text: string): PointRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const out: PointRow[] = []
  for (const r of rows.slice(1)) {
    const get = (i: number) => (i >= 0 && i < r.length ? r[i].trim() : '')
    const areaRaw = get(col('area'))
    const addressRaw = get(col('address'))
    if (!areaRaw || !addressRaw) continue
    const address = parseAddress(addressRaw)
    if (!Number.isFinite(address)) continue
    const factor = Number(get(col('factor')))
    const offset = Number(get(col('offset')))
    out.push({
      area: areaRaw as ModbusArea,
      address,
      alias: get(col('alias')) || null,
      dataType: get(col('data_type')) || 'int16',
      unit: get(col('unit')) || null,
      factor: Number.isFinite(factor) ? factor : 1,
      offset: Number.isFinite(offset) ? offset : 0,
      enumMap: parseEnumNotation(get(col('enum'))),
    })
  }
  return out
}
