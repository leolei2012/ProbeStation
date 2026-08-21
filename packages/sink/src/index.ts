import type { Context } from 'cordis'
import ExcelJS from 'exceljs'
import { areaForFunction, formatRawByAddr } from '@probebench/core'

export const name = 'sink'
export const inject = ['config', 'store']

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
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

  async exportCsv(objectId: number, start: string, end: string, registerIds?: number[]): Promise<string> {
    const { registers, tsOrder, formatted } = await this.collect(objectId, start, end, registerIds)
    const header = ['timestamp', ...registers.map((r: any) => r.alias ?? `reg${r.id}`)]
    const lines = [header.map(escapeCsv).join(',')]
    for (const ts of tsOrder) {
      const m = formatted.get(ts)!
      const cells = [ts, ...registers.map((r: any) => m.get(r.id) ?? '')]
      lines.push(cells.map(escapeCsv).join(','))
    }
    return lines.join('\n')
  }

  async exportXlsx(objectId: number, start: string, end: string, registerIds?: number[]): Promise<Buffer> {
    const { registers, tsOrder, formatted } = await this.collect(objectId, start, end, registerIds)
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('data')
    sheet.columns = [
      { header: 'timestamp', key: 'ts', width: 24 },
      ...registers.map((r: any) => ({ header: r.alias ?? `reg${r.id}`, key: `r${r.id}`, width: 16 })),
    ]
    for (const ts of tsOrder) {
      const row: Record<string, unknown> = { ts }
      const m = formatted.get(ts)!
      for (const r of registers) row[`r${r.id}`] = m.get(r.id) ?? null
      sheet.addRow(row)
    }
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  }
}

export function apply(ctx: Context): void {
  ctx.provide('sink', new Sink(ctx))
}
