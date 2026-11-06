import type ExcelJS from 'exceljs'
import { DATA_TYPES, baseType, isLittleEndian, registerWidth } from '../../core/src/codec.ts'
import { ALARM_OPERATORS } from '../../core/src/alarm.ts'
import { assertImportedPointGroup, type ImportedPointGroup } from '../../core/src/point-import.ts'
import { parseRegisterQuantity } from '../../config/src/register-quantity.ts'

interface Alarm { operator: string; threshold: number; message: string | null }
export interface BookPoint {
  alias: string | null; dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null
  functionCode: number; startAddress: number; quantity: number; decimalPlaces: number | null; alarms: Alarm[]
}
export interface BookGroup extends ImportedPointGroup { points: BookPoint[] }
const head = ['别名', '数据类型', '单位', '系数', '偏移', '枚举', '功能码', '起始地址', '数量', '小数位数']
const alarmHead = ['分组', '功能码', '起始地址', '告警条件', '原始值阈值', '告警提示']
const cell = (row: ExcelJS.Row, index: number): string => {
  const value = row.getCell(index).value
  return value == null ? '' : typeof value === 'object' ? String((value as any).text ?? (value as any).result ?? '') : String(value)
}
const invalid = (message: string): never => { throw new Error(message) }
function integer(text: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) invalid(label + '须为' + min + '–' + max + '的十进制整数')
  return Number(text)
}
function finite(text: string, fallback: number, label: string): number {
  if (!text) return fallback
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) invalid(label + '须为有限数值')
  return Number(text)
}
function enums(text: string): string | null {
  if (!text) return null
  const values: Record<string, string> = Object.create(null)
  for (const pair of text.split(';')) {
    if (!pair.trim()) continue
    const i = pair.indexOf('=')
    if (i < 1 || !pair.slice(0, i).trim()) invalid('枚举须使用值=标签;值=标签格式')
    values[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return JSON.stringify(values)
}

/** Parse/validate the existing v2 workbook entirely before any configuration writes. */
export function parsePointBook(wb: ExcelJS.Workbook): { groups: BookGroup[]; errors: string[]; warnings: string[] } {
  const groups: BookGroup[] = [], errors: string[] = [], warnings: string[] = []
  const locations = new Map<string, Array<{ sheet: string; point: BookPoint }>>()
  const key = (group: string, fc: number, address: number) => JSON.stringify([group, fc, address])
  for (const ws of wb.worksheets) {
    if (['设备信息', '告警规则'].includes(ws.name)) continue
    const label = 'sheet ' + ws.name
    try {
      if (ws.rowCount < 4 || cell(ws.getRow(1), 1).trim() !== '分组') invalid('缺少分组头或点位列头')
      const name = cell(ws.getRow(1), 2) || ws.name, row2 = ws.getRow(2), header = ws.getRow(4)
      if (!name.trim()) invalid('分组名不可全为空白')
      if (!cell(ws.getRow(1), 2)) warnings.push(label + ' 未提供分组名，沿用工作表名称，请核对。')
      const values = new Map<string, string>()
      for (let column = 1; column <= 7; column += 2) {
        const field = cell(row2, column).trim(), value = cell(row2, column + 1).trim()
        if (!field && !value) continue
        if (!['从站', '功能码', '起始地址', '数量'].includes(field) || values.has(field)) invalid('分组头字段缺失、重复或不支持：' + field)
        values.set(field, value)
      }
      if (head.some((h, i) => (i < 8 || cell(header, i + 1).trim()) && cell(header, i + 1).trim() !== h)) invalid('点位列头不正确，请使用v2固定列序')
      const sourceText = values.get('从站') ?? '', fcText = values.get('功能码') ?? ''
      const slaveId = sourceText ? integer(sourceText, 1, 247, '从站') : 1
      const functionCode = fcText ? integer(fcText, 1, 4, '功能码') : 3
      if (!sourceText) warnings.push(label + ' 未提供从站，沿用旧默认1；不是已确认的物理来源，请核对。')
      if (!fcText) warnings.push(label + ' 未提供功能码，沿用旧默认FC03，请核对。')
      const points: BookPoint[] = []
      for (let ri = 5; ri <= ws.rowCount; ri++) {
        const fields = head.map((_, i) => cell(ws.getRow(ri), i + 1).trim())
        if (fields.every(v => !v)) continue
        try {
          const [alias, rawType, unit, factorText, offsetText, enumText, pointFc, addressText, quantityText, decimalText] = fields
          for (const index of [8, 9]) if (fields[index] && !cell(header, index + 1).trim()) invalid('非空数量/小数位数数据缺少对应列头')
          const startAddress = integer(addressText, 0, 65535, '起始地址'), dataType = rawType || 'int16'
          if (!(DATA_TYPES as readonly string[]).includes(baseType(dataType) + (isLittleEndian(dataType) ? '-LE' : ''))) invalid('不支持的数据类型')
          if (startAddress + registerWidth(dataType) > 65536) invalid('完整dtype字宽超出地址65535')
          const fc = pointFc ? integer(pointFc, 1, 4, '点位功能码') : functionCode
          if (fc !== functionCode) invalid('点位功能码与分组不一致')
          const quantity = quantityText ? parseRegisterQuantity(integer(quantityText, 1, Number.MAX_SAFE_INTEGER, '点位数量元数据')) : 1
          points.push({ alias: alias || null, dataType, unit: unit || null, factor: finite(factorText, 1, '系数'), offset: finite(offsetText, 0, '偏移'),
            enumJson: enums(enumText), functionCode: fc, startAddress, quantity, decimalPlaces: decimalText ? integer(decimalText, 0, 8, '小数位数') : null, alarms: [] })
        } catch (error: any) { errors.push(label + ' 第 ' + ri + ' 行：' + error.message) }
      }
      const startText = values.get('起始地址') ?? '', countText = values.get('数量') ?? ''
      if (Boolean(startText) !== Boolean(countText)) invalid('分组起始地址与数量需同时填写或同时留空')
      let startAddress: number, quantity: number
      if (startText && countText) {
        startAddress = integer(startText, 0, 65535, '分组起始地址'); quantity = integer(countText, 1, 65536 - startAddress, '分组数量')
      } else {
        if (!points.length) invalid('没有有效点位或显式范围，无法推导分组跨度')
        startAddress = points.reduce((min, p) => Math.min(min, p.startAddress), 65535)
        quantity = points.reduce((end, p) => Math.max(end, p.startAddress + registerWidth(p.dataType)), 0) - startAddress
        warnings.push(label + ' 未提供范围，按点位起始地址及完整dtype字宽推导；未连接设备，请核对。')
      }
      const group: BookGroup = { name, slaveId, functionCode, startAddress, quantity, mode: 'read', points }
      assertImportedPointGroup(group, groups.length)
      for (const point of points) {
        if (point.startAddress < startAddress || point.startAddress + registerWidth(point.dataType) > startAddress + quantity) invalid('点位' + point.startAddress + '完整dtype字宽超出显式分组范围，未自动扩组')
        const id = key(name, point.functionCode, point.startAddress)
        locations.set(id, [...(locations.get(id) ?? []), { sheet: ws.name, point }])
      }
      groups.push(group)
    } catch (error: any) { errors.push(label + '：' + error.message) }
  }
  const alarms = wb.getWorksheet('告警规则')
  if (!alarms) errors.push('缺少「告警规则」页，请使用新版点位表模板；无告警时保留空表头。')
  else {
    if (alarmHead.some((h, i) => cell(alarms.getRow(1), i + 1).trim() !== h)) errors.push('「告警规则」页列头不正确，请使用新版模板。')
    const sheetHeader = cell(alarms.getRow(1), 7).trim()
    if (sheetHeader && sheetHeader !== '点位工作表') errors.push('「告警规则」页第G列须为点位工作表，不能猜测定位列。')
    for (let ri = 2; ri <= alarms.rowCount; ri++) {
      const fields = alarmHead.map((_, i) => cell(alarms.getRow(ri), i + 1))
      const sheet = cell(alarms.getRow(ri), 7)
      if (fields.every(f => !f.trim()) && !sheet.trim()) continue
      try {
        const [group, fc, address, rawOperator, limit, message] = fields
        const operator = rawOperator.trim().replace('≥', '>=').replace('≤', '<=').replace('≠', '!=').replace(/^=$/, '==')
        if (!group.trim() || !/^\d+$/.test(fc.trim()) || !/^\d+$/.test(address.trim()) || !ALARM_OPERATORS.includes(operator as any) || !limit.trim() || !Number.isFinite(Number(limit)) || message.length > 200) invalid('分组、功能码、地址、条件、阈值或提示无效')
        if (sheet && (sheetHeader !== '点位工作表' || !sheet.trim())) invalid('工作表定位缺少列头或仅为空白')
        let matches = locations.get(key(group, Number(fc), Number(address))) ?? []
        if (sheet) matches = matches.filter(location => location.sheet.toLowerCase() === sheet.toLowerCase())
        if (matches.length !== 1) invalid(matches.length ? '对应点位不唯一' : '找不到对应点位')
        matches[0].point.alarms.push({ operator, threshold: Number(limit), message: message.trim() || null })
      } catch (error: any) { errors.push('告警规则第 ' + ri + ' 行：' + error.message) }
    }
  }
  return { groups, errors, warnings }
}
