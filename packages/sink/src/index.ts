import type { Context } from 'cordis'
import ExcelJS from 'exceljs'

export const name = 'sink'
export const inject = ['config', 'store']

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

/** 数据导出（CSV / XLSX），宽表格式：时间戳 + 每个寄存器一列。 */
export class Sink {
  constructor(private readonly ctx: any) {}

  private async collect(objectId: number, start: string, end: string) {
    const registers = this.ctx.config.listRegistersByObject(objectId)
    const points = await this.ctx.store.queryObject(objectId, start, end)
    // pivot: ts -> Map<registerId, value>
    const tsOrder: string[] = []
    const rows = new Map<string, Map<number, number>>()
    for (const p of points) {
      if (!rows.has(p.ts)) { rows.set(p.ts, new Map()); tsOrder.push(p.ts) }
      rows.get(p.ts)!.set(p.registerId, p.rawValue)
    }
    return { registers, tsOrder, rows }
  }

  async exportCsv(objectId: number, start: string, end: string): Promise<string> {
    const { registers, tsOrder, rows } = await this.collect(objectId, start, end)
    const header = ['timestamp', ...registers.map(r => r.alias ?? `reg${r.id}`)]
    const lines = [header.map(escapeCsv).join(',')]
    for (const ts of tsOrder) {
      const row = rows.get(ts)!
      const cells = [ts, ...registers.map(r => String(row.get(r.id) ?? ''))]
      lines.push(cells.map(escapeCsv).join(','))
    }
    return lines.join('\n')
  }

  async exportXlsx(objectId: number, start: string, end: string): Promise<Buffer> {
    const { registers, tsOrder, rows } = await this.collect(objectId, start, end)
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('data')
    sheet.columns = [
      { header: 'timestamp', key: 'ts', width: 24 },
      ...registers.map(r => ({ header: r.alias ?? `reg${r.id}`, key: `r${r.id}`, width: 16 })),
    ]
    for (const ts of tsOrder) {
      const row: Record<string, unknown> = { ts }
      const m = rows.get(ts)!
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
