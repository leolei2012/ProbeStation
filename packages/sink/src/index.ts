import type { Context } from 'cordis'
import ExcelJS from 'exceljs'
import { areaForFunction, formatRawByAddr } from '@probebench/core'

export const name = 'sink'
export const inject = ['config', 'store']

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

/** 把 UTC ISO 时间戳按给定分钟偏移转成本地时间字面（东为正，0=UTC）。不依赖服务器本地时区。 */
function formatTsLocal(ts: string, offsetMin: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts || ''
  const shifted = new Date(d.getTime() + offsetMin * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds())
}

/** 偏移分钟数对应的时区标签：0 → 'UTC'，东八区 → 'UTC+08:00'。 */
function tzLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC'
  const sign = offsetMin > 0 ? '+' : '-'
  const a = Math.abs(offsetMin)
  return 'UTC' + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0')
}

/** sheet 名不允许包含 :\/?*[]，超长截断。 */
function sanitizeSheetName(n: string): string {
  const cleaned = String(n).replace(/[\\/:*?[\]]/g, '_').slice(0, 31)
  return cleaned || 'sheet'
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
    let registers = this.ctx.config.listRegistersByObject(objectId)
    if (registerIds && registerIds.length > 0) {
      const idSet = new Set(registerIds)
      registers = registers.filter((r: any) => idSet.has(r.id))
    }
    const points = await this.ctx.store.queryObject(objectId, start, end)
    // pivot: ts -> area -> { address: rawValue }，避免四数据区同地址互相覆盖。
    const tsOrder: string[] = []
    const rawByTs = new Map<string, Map<string, Record<number, number>>>()
    for (const p of points) {
      if (!rawByTs.has(p.ts)) { rawByTs.set(p.ts, new Map()); tsOrder.push(p.ts) }
      const byArea = rawByTs.get(p.ts)!
      if (!byArea.has(p.area)) byArea.set(p.area, {})
      byArea.get(p.area)![p.address] = p.rawValue
    }
    // format per ts: ts -> Map<registerId, string|null>
    const formatted = new Map<string, Map<number, string | null>>()
    for (const ts of tsOrder) {
      const result = new Map<number, string | null>()
      const byArea = rawByTs.get(ts)!
      for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) {
        const subset = registers.filter((r: any) => areaForFunction(r.functionCode) === area)
        for (const [id, value] of formatRawByAddr(subset, byArea.get(area) ?? {})) result.set(id, value)
      }
      formatted.set(ts, result)
    }
    return { registers, tsOrder, formatted }
  }

  async exportCsv(objectId: number, start: string, end: string, registerIds?: number[], tzOffsetMin = 0): Promise<string> {
    const { registers, tsOrder, formatted } = await this.collect(objectId, start, end, registerIds)
    const header = [['timestamp', '(', tzLabel(tzOffsetMin), ')'].join(''), ...registers.map((r: any) => r.alias ?? `reg${r.id}`)]
    const lines = [header.map(escapeCsv).join(',')]
    for (const ts of tsOrder) {
      const m = formatted.get(ts)!
      const cells = [formatTsLocal(ts, tzOffsetMin), ...registers.map((r: any) => m.get(r.id) ?? '')]
      lines.push(cells.map(escapeCsv).join(','))
    }
    return lines.join('\n')
  }

  async exportXlsx(objectId: number, start: string, end: string, registerIds?: number[], tzOffsetMin = 0): Promise<Buffer> {
    const { registers, tsOrder, formatted } = await this.collect(objectId, start, end, registerIds)
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('data')
    sheet.columns = [
      { header: `timestamp (${tzLabel(tzOffsetMin)})`, key: 'ts', width: 24 },
      ...registers.map((r: any) => ({ header: r.alias ?? `reg${r.id}`, key: `r${r.id}`, width: 16 })),
    ]
    for (const ts of tsOrder) {
      const row: Record<string, unknown> = { ts: formatTsLocal(ts, tzOffsetMin) }
      const m = formatted.get(ts)!
      for (const r of registers) row[`r${r.id}`] = m.get(r.id) ?? null
      sheet.addRow(row)
    }
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  }

  /**
   * 点表导出：把一台设备的点位（寄存器带全语义）导成 xlsx，
   * **每个寄存器分组单独作为一个 sheet**（分组名即 sheet 名）。
   * sheet 布局固定、便于本文件的对称导入重建（见 config.importPointBook）：
   *   第1行：分组,<名>
   *   第2行：从站,<v>, 功能码,<v>, 起始地址,<v>, 数量,<v>
   *   第3行空
   *   第4行：列头  功能码 | 起始地址 | 数量 | 别名 | 数据类型 | 单位 | 系数 | 偏移 | 枚举
   *   第5行起：每行一条寄存器
   * 另有「设备信息」sheet 存连接参数（导入用于可选建连接）。
   */
  async exportPointSheet(objectId: number): Promise<{ buffer: Buffer; filename: string }> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('device not found: ' + objectId)
    const groups = this.ctx.config.listGroups(objectId)
    const wb = new ExcelJS.Workbook()

    // 设备信息 sheet
    const info = wb.addWorksheet('设备信息')
    info.columns = [{ header: 'key', key: 'k', width: 20 }, { header: 'value', key: 'v', width: 44 }]
    ;[
      ['设备名', obj.name],
      ['连接', obj.transport === 'rtu' ? 'RTU:' + (obj.serialPath ?? '') : ((obj.ip ?? '') + ':' + obj.port)],
      ['从站', String(obj.slaveId ?? 1)],
      ['扫描间隔ms', String(obj.pollIntervalMs ?? 1000)],
      ['分组数', String(groups.length)],
    ].forEach(([k, v]) => info.addRow({ k, v }))
    boldRows(info, 1)

    // 每分组一个 sheet
    for (const g of groups) {
      const regs = [...this.ctx.config.listRegisters(g.id)].sort((a: any, b: any) => a.startAddress - b.startAddress)
      const name = sanitizeSheetName(g.name || ('分组' + g.id))
      const s = wb.addWorksheet(name)
      // 第1、2行：分组头；(第3行留空)
      s.addRow(['分组', g.name])
      s.addRow(['从站', g.slaveId ?? obj.slaveId ?? 1, '功能码', g.functionCode, '起始地址', g.startAddress, '数量', g.quantity])
      s.addRow([])
      // 第4行：数据列头
      const head = ['别名', '数据类型', '单位', '系数', '偏移', '枚举', '功能码', '起始地址', '数量']
      s.addRow(head)
      boldRows(s, 4)
      // 第5行起：每行一条寄存器（固定列序；导出值均作字符串便于往返）
      for (const r of regs) {
        s.addRow([
          r.alias ?? '', r.dataType ?? 'int16', r.unit ?? '', String(r.factor ?? 1), String(r.offset ?? 0),
          r.enumJson ? safeJson(r.enumJson) : '', String(r.functionCode), String(r.startAddress), String(r.quantity ?? 1),
        ])
      }
      void head
    }
    const buf = await wb.xlsx.writeBuffer()
    return { buffer: Buffer.from(buf), filename: `${obj.name || ('device' + objectId)}_点表_${new Date().toISOString().slice(0, 10)}.xlsx` }
  }

  /**
   * 从 exportPointSheet 产出的 xlsx 导入点位：每个非「设备信息」sheet = 一个分组，
   * 布局与 exportPointSheet 严格对应（见其文档注释）。
   * replace=true 会先删除该设备现有全部分组/寄存器再建（X 幂等覆盖）。
   */
  async importPointBook(objectId: number, buffer: Buffer, replace = true): Promise<{ groups: number; registers: number; errors: string[] }> {
    if (!this.ctx.config.getObject(objectId)) throw new Error('device not found: ' + objectId)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as any)
    const cfg = this.ctx.config
    if (replace) {
      // 删除旧点（分组/寄存器级联）
      const oldGroups = cfg.listGroups(objectId)
      for (const g of oldGroups) cfg.deleteGroup(g.id)
    }
    const errors: string[] = []
    let groups = 0
    let registers = 0
    const cell = (row: any, idx: number): string => {
      const c = row?.getCell(idx)?.value
      if (c == null) return ''
      return typeof c === 'object' ? String((c as any).text ?? (c as any).result ?? '') : String(c)
    }
    wb.eachSheet((ws: any) => {
      if (ws.name === '设备信息') return
      const nRows = ws.rowCount
      if (nRows < 2) { errors.push('sheet "' + ws.name + '" 空，跳过'); return }
      const r1 = ws.getRow(1)
      const groupName = cell(r1, 2) || ws.name
      // 读分组头（第2行“从站,..,功能码,..,起始地址,..,数量,..”）
      const r2 = ws.getRow(2)
      let fc = 3
      let start = 0
      let qty = 0
      for (let c = 1; c <= 7; c += 2) {
        const label = cell(r2, c).trim()
        if (label === '从站') { /* 忽略 slave，用 obj 默认 */ }
        else if (label === '功能码') fc = parseInt(cell(r2, c + 1), 10) || fc
        else if (label === '起始地址') start = parseInt(cell(r2, c + 1), 10) || 0
        else if (label === '数量') qty = parseInt(cell(r2, c + 1), 10) || 0
      }
      const g = cfg.createGroup(objectId, groupName, fc, start, Infinity)
      groups++
      // 第4行是列头，数据从第5行起；但更稳：跳过前两个空行与前两行分组头，从第3行？布局：r1 分组, r2 从站.., r3 空, r4 列头, r5..数据
      const dataStart = 5
      let added = 0
      let lo = Infinity
      let hi = -Infinity
      const addRowReg = (alias: string, dataType: string, unit: string, factor: number, offset: number, enumJson: string | null, regFc: number, addr: number) => {
        cfg.createRegister(g.id, objectId, alias || null, regFc, addr, dataType, { unit: unit || null, factor, offset, enumJson })
        added++
        if (addr < lo) lo = addr
        if (addr > hi) hi = addr
      }
      for (let ri = dataStart; ri <= nRows; ri++) {
        const row = ws.getRow(ri)
        const alias = cell(row, 1).trim()
        const dtRaw = cell(row, 2).trim()
        const unit = cell(row, 3).trim()
        const factor = parseFloat(cell(row, 4)) || 1
        const offset = parseFloat(cell(row, 5)) || 0
        const enumRaw = cell(row, 6).trim()
        const rcFc = parseInt(cell(row, 7), 10)
        const addr = parseInt(cell(row, 8), 10)
        if (!alias && Number.isNaN(addr) && !dtRaw && !unit) continue
        if (Number.isNaN(addr)) { errors.push('sheet ' + groupName + ' 第 ' + ri + ' 行地址非法'); continue }
        const dataType = dtRaw || 'int16'
        let enumJson: string | null = null
        if (enumRaw) {
          try {
            const o: Record<string, string> = {}
            for (const pair of enumRaw.split(';')) { const i = pair.indexOf('='); if (i > 0) o[pair.slice(0, i).trim()] = pair.slice(i + 1).trim() }
            enumJson = JSON.stringify(o)
          } catch { enumJson = null }
        }
        addRowReg(alias, dataType, unit, factor, offset, enumJson, Number.isNaN(rcFc) ? fc : rcFc, addr)
        registers++
      }
      // 分组 quantity 覆盖该组取读的最宽连续跨度（含可能的 gap 宽读，与人工点表一致）
      if (added > 0) cfg.updateGroup(g.id, { quantity: hi >= lo ? (hi - lo + 1) : added, startAddress: lo })
      else { errors.push('sheet ' + groupName + ' 无可解析点行'); }
    })
    cfg.log('INFO', 'sink', 'importPointBook ' + objectId + ' -> groups=' + groups + ' regs=' + registers + (errors.length ? ' errs=' + errors.join(';') : ''))
    return { groups, registers, errors }
  }
}

export function apply(ctx: Context): void {
  ctx.provide('sink', new Sink(ctx))
}
