import type { Context } from 'cordis'
import ExcelJS from 'exceljs'
import { parsePointBook } from './pointbook.ts'
import { assertExportableGroupName, createSheetNameAllocator } from './sheet-names.ts'
import { historyColumnNames } from './history-columns.ts'
import { areaForFunction, formatRegisterValue, decodeHistoricalSample, historyVerificationLabel, type HistoryVerification } from '@probebench/core'
import { HISTORY_EXPORT_RAW_LIMIT, HistoryExportLimitError, historyExportReadRanges } from '../../core/src/history-export-policy.ts'
import { withRegisterSources } from '../../core/src/sample-source.ts'
import type { PointBookImportReport } from '../../config/src/index.ts'

export const name = 'sink'
export const inject = ['config', 'store']

function escapeCsv(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

/** 把 UTC ISO 时间戳按给定分钟偏移转成本地时间字面（东为正，0=UTC）。不依赖服务器本地时区。 */
function formatTsLocal(ts: string, offsetMin: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts || ''
  const shifted = new Date(d.getTime() + offsetMin * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + (shifted.getUTCMilliseconds() ? '.' + String(shifted.getUTCMilliseconds()).padStart(3, '0') : '')
}

/** 偏移分钟数对应的时区标签：0 → 'UTC'，东八区 → 'UTC+08:00'。 */
function tzLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC'
  const sign = offsetMin > 0 ? '+' : '-'
  const a = Math.abs(offsetMin)
  return 'UTC' + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0')
}

/** enum_json 转可读 "值=标签;..." 字符串。 */
function safeJson(v: string): string {
  try {
    const m = JSON.parse(v)
    if (m && typeof m === 'object') return Object.keys(m).map((k) => k + '=' + String(m[k])).join('; ')
    return String(v)
  } catch { return v }
}

/** 对 exceljs sheet 顶部几行做加粗（分组标题行）。 */
function boldRows(sheet: any, count: number): void {
  for (let i = 1; i <= count; i++) {
    const row = sheet.getRow(i)
    if (!row) continue
    for (let c = 1; c <= row.cellCount; c++) { const cell = row.getCell(c); if (cell) cell.font = { bold: true } }
  }
}


/** 数据导出（CSV / XLSX），宽表格式：时间戳 + 每个寄存器一列（已按类型解码/格式化）。 */
export class Sink {
  constructor(private readonly ctx: any) {}

  private async collect(objectId: number, start: string, end: string, registerIds?: number[]) {
    let registers = withRegisterSources<any>(this.ctx.config.listRegistersByObject(objectId), this.ctx.config.listGroups?.(objectId) ?? [], this.ctx.config.getObject?.(objectId))
    if (registerIds && registerIds.length > 0) {
      const idSet = new Set(registerIds)
      registers = registers.filter((r: any) => idSet.has(r.id))
    }
    const points = registers.length ? await this.ctx.store.queryObjectForExport(objectId, start, end, historyExportReadRanges(registers)) : []
    if (points.length > HISTORY_EXPORT_RAW_LIMIT) throw new HistoryExportLimitError()
    const byTs = new Map<string, typeof points>()
    for (const p of points) { const ts = p.timestampMs != null ? new Date(p.timestampMs).toISOString() : p.ts; if (!byTs.has(ts)) byTs.set(ts, []); byTs.get(ts)!.push(p) }
    const tsOrder = [...byTs.keys()]
    const formatted = new Map<string, Map<number, string | null>>()
    const verification = new Map<string, Map<number, HistoryVerification>>()
    for (const [ts, rows] of byTs) {
      const values = new Map<number, string | null>(), states = new Map<number, HistoryVerification>()
      for (const r of registers) {
        const sample = decodeHistoricalSample(r, rows.filter((p: any) => p.area === areaForFunction(r.functionCode)))
        values.set(r.id, sample.value == null ? null : formatRegisterValue(r.dataType, sample.words))
        states.set(r.id, sample.verification)
      }
      formatted.set(ts, values); verification.set(ts, states)
    }
    return { registers, tsOrder, formatted, verification }
  }

  async exportCsv(objectId: number, start: string, end: string, registerIds?: number[], tzOffsetMin = 0): Promise<string> {
    const { registers, tsOrder, formatted, verification } = await this.collect(objectId, start, end, registerIds)
    const timestamp = `timestamp(${tzLabel(tzOffsetMin)})`
    const names = historyColumnNames(registers, [timestamp, `timestamp (${tzLabel(tzOffsetMin)})`])
    const header = [timestamp, ...names.flatMap(name => [name, name + '__batch_status', name + '__automatic_eligible'])]
    const lines = [header.map(escapeCsv).join(',')]
    for (const ts of tsOrder) {
      const m = formatted.get(ts)!
      const cells = [formatTsLocal(ts, tzOffsetMin), ...registers.flatMap((r: any) => { const state = verification.get(ts)!.get(r.id)!; return [m.get(r.id) ?? '', historyVerificationLabel[state], state === 'verified' ? 'true' : 'false'] })]
      lines.push(cells.map(escapeCsv).join(','))
    }
    return lines.join('\n')
  }

  async exportXlsx(objectId: number, start: string, end: string, registerIds?: number[], tzOffsetMin = 0): Promise<Buffer> {
    const { registers, tsOrder, formatted, verification } = await this.collect(objectId, start, end, registerIds)
    const names = historyColumnNames(registers, [`timestamp(${tzLabel(tzOffsetMin)})`, `timestamp (${tzLabel(tzOffsetMin)})`])
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('data')
    sheet.columns = [
      { header: `timestamp (${tzLabel(tzOffsetMin)})`, key: 'ts', width: 24 },
      ...registers.flatMap((r: any, i: number) => [{ header: names[i], key: `r${r.id}`, width: 24 }, { header: names[i] + '__batch_status', key: `s${r.id}`, width: 28 }, { header: names[i] + '__automatic_eligible', key: `a${r.id}`, width: 32 }]),
    ]
    for (const ts of tsOrder) {
      const row: Record<string, unknown> = { ts: formatTsLocal(ts, tzOffsetMin) }
      const m = formatted.get(ts)!
      for (const r of registers) {
        const state = verification.get(ts)!.get(r.id)!
        row[`r${r.id}`] = m.get(r.id) ?? null; row[`s${r.id}`] = historyVerificationLabel[state]; row[`a${r.id}`] = state === 'verified'
      }
      sheet.addRow(row)
    }
    const notes = wb.addWorksheet('历史身份说明')
    notes.addRow(['批次/来源未验证的值仅供查看，不可作为自动 PASS/FAIL 依据。无法归属从站、混批或缺字等未知值留空。'])
    notes.addRow(['automatic_eligible 只表示目标从站来源明确、完整同批且质量有效，不表示测试通过；本程序未生成 PASS/FAIL。'])
    notes.addRow(['重名列附从站和点位ID；从站指当前配置目标，不能替代逐行批次/来源状态。原始别名以JSON文本保存。'])
    notes.addRow([])
    notes.addRow(['数据列', '点位ID', '分组ID', '从站（当前配置）', '数据区', '地址', 'dtype', '原始别名(JSON)'])
    registers.forEach((r: any, i: number) => notes.addRow([names[i], r.id, r.groupId ?? null, r.slaveId ?? null, areaForFunction(r.functionCode), r.startAddress, r.dataType, JSON.stringify(r.alias ?? null)]))
    notes.columns = [38, 12, 12, 20, 22, 12, 18, 48].map(width => ({ width }))
    notes.getRow(5).font = { bold: true }
    notes.views = [{ state: 'frozen', ySplit: 5 }]
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  }

  /**
   * 点表导出：把一台设备的点位（寄存器带全语义）导成 xlsx，
   * **每个寄存器分组单独作为一个 sheet**（分组名即 sheet 名）。
   * sheet 布局固定、便于本文件的对称导入重建（见 importPointBook）：
   *   第1行：分组,<名>
   *   第2行：从站,<v>, 功能码,<v>, 起始地址,<v>, 数量,<v>
   *   第3行空
   *   第4行：别名 | 数据类型 | 单位 | 系数 | 偏移 | 枚举 | 功能码 | 起始地址 | 数量 | 小数位数 | 告警数量 | 点位标识
   *   第5行起：每行一条寄存器
   * 另有「设备信息」sheet 存连接参数，仅供参考，导入不修改设备连接。
   */
  async exportPointSheet(objectId: number): Promise<{ buffer: Buffer; filename: string }> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('device not found: ' + objectId)
    const groups = this.ctx.config.listGroups(objectId)
    const rules = this.ctx.config.listRules()
    const allocate = createSheetNameAllocator()
    const sheets = groups.map((g: any) => {
      assertExportableGroupName(g.name)
      const regs = [...this.ctx.config.listRegisters(g.id)].sort((a: any, b: any) => a.startAddress - b.startAddress || a.id - b.id)
      return { g, regs, name: allocate(g.name) }
    })
    const wb = new ExcelJS.Workbook()

    // 设备信息 sheet
    const info = wb.addWorksheet('设备信息')
    info.columns = [{ header: 'key', key: 'k', width: 20 }, { header: 'value', key: 'v', width: 44 }]
    ;[
      ['点位表版本', '2'],
      ['设备名', obj.name],
      ['连接', obj.transport === 'rtu' ? 'RTU:' + (obj.serialPath ?? '') : ((obj.ip ?? '') + ':' + obj.port)],
      ['从站', String(obj.slaveId ?? 1)],
      ['扫描间隔ms', String(obj.pollIntervalMs ?? 1000)],
      ['分组数', String(groups.length)],
    ].forEach(([k, v]) => info.addRow({ k, v }))
    boldRows(info, 1)

    const alarmSheet = wb.addWorksheet('告警规则')
    alarmSheet.addRow(['分组', '功能码', '起始地址', '告警条件', '原始值阈值', '告警提示', '点位工作表', '点位标识'])
    alarmSheet.columns = [{ width: 24 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 48 }, { width: 32 }, { width: 20 }]
    boldRows(alarmSheet, 1)
    alarmSheet.views = [{ state: 'frozen', ySplit: 1 }]
    // 每分组一个 sheet
    let pointSequence = 0
    for (const { g, regs, name } of sheets) {
      const s = wb.addWorksheet(name)
      // 第1、2行：分组头；(第3行留空)
      s.addRow(['分组', g.name])
      s.addRow(['从站', g.slaveId ?? obj.slaveId ?? 1, '功能码', g.functionCode, '起始地址', g.startAddress, '数量', g.quantity])
      s.addRow([])
      // 第4行：数据列头
      const head = ['别名', '数据类型', '单位', '系数', '偏移', '枚举', '功能码', '起始地址', '数量', '小数位数', '告警数量', '点位标识']
      s.addRow(head)
      boldRows(s, 4)
      // 第5行起：每行一条寄存器（固定列序；导出值均作字符串便于往返）
      for (const r of regs) {
        const localId = 'p' + ++pointSequence // Workbook-local only; never expose or persist database IDs.
        const alarms = rules.filter((rule: any) => rule.registerId === r.id).map(({ operator, threshold, message }: any) => ({ operator, threshold, message }))
        for (const alarm of alarms) alarmSheet.addRow([g.name, r.functionCode, r.startAddress, alarm.operator, String(alarm.threshold), alarm.message ?? '', name, localId])
        s.addRow([
          r.alias ?? '', r.dataType ?? 'int16', r.unit ?? '', String(r.factor ?? 1), String(r.offset ?? 0),
          r.enumJson ? safeJson(r.enumJson) : '', String(r.functionCode), String(r.startAddress), String(r.quantity ?? 1), r.decimalPlaces == null ? '' : String(r.decimalPlaces), alarms.length || '', localId,
        ])
      }
      s.columns = [24, 18, 12, 12, 12, 32, 12, 14, 10, 12, 12, 20].map(width => ({ width }))
      s.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }]
      s.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: head.length } }
      s.getColumn(11).eachCell((cell, row) => { if (row >= 5) cell.font = { color: { argb: 'FF777777' } } })
    }
    alarmSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } }
    for (const sheet of wb.worksheets) {
      sheet.eachRow((row, index) => {
        row.height = 26
        const header = ['设备信息', '告警规则'].includes(sheet.name) ? index === 1 : index === 4
        row.eachCell(cell => {
          cell.alignment = { vertical: 'middle', wrapText: true }
          if (header) { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF303030' } } }
          else if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F4' } }
        })
      })
    }
    const buf = await wb.xlsx.writeBuffer()
    return { buffer: Buffer.from(buf), filename: `${obj.name || ('device' + objectId)}_点表_${new Date().toISOString().slice(0, 10)}.xlsx` }
  }

  /**
   * 从 exportPointSheet 产出的 xlsx 导入点位：除「设备信息」「告警规则」之外，每个 sheet = 一个分组，
   * 布局与 exportPointSheet 严格对应（见其文档注释）。
   * replace=true 在一个事务内替换全部分组/寄存器/告警；解析行错误或写入失败回滚。
   */
  async importPointBook(objectId: number, buffer: Buffer, replace = true): Promise<PointBookImportReport> {
    if (!this.ctx.config.getObject(objectId)) throw new Error('device not found: ' + objectId)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as any)
    const cfg = this.ctx.config
    const parsed = parsePointBook(wb)
    if (parsed.errors.length) return { groups: 0, registers: 0, errors: parsed.errors, warnings: parsed.warnings }
    const result: PointBookImportReport = cfg.applyPointBookImport(objectId, replace, () => {
      let registers = 0
      for (const group of parsed.groups) {
        const g = cfg.createGroup(objectId, group.name, group.functionCode, group.startAddress, group.quantity, group.mode, group.slaveId)
        for (const point of group.points) {
          const reg = cfg.createRegister(g.id, objectId, point.alias, point.functionCode, point.startAddress, point.dataType, point)
          for (const alarm of point.alarms) cfg.createRule(reg.id, alarm.operator, alarm.threshold, alarm.message)
          registers++
        }
      }
      return { groups: parsed.groups.length, registers, errors: [] }
    })
    result.warnings = [...parsed.warnings, ...result.warnings]
    if (!result.errors.length) {
      try { cfg.log('INFO', 'sink', 'importPointBook ' + objectId + ' -> groups=' + result.groups + ' regs=' + result.registers) }
      catch { result.warnings.push('点位表已提交，但日志写入失败；请核对返回结果，勿重复导入。') }
    }
    return result
  }
}

export function apply(ctx: Context): void {
  ctx.provide('sink', new Sink(ctx))
}
