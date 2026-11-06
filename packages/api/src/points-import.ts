import type { FastifyInstance } from 'fastify'
import ExcelJS from 'exceljs'
import { smartParseCsv, smartParseTable } from '../../core/src/points.ts'
import { normalizeSemanticPoint } from '../../core/src/semantic-import.ts'
import type { ConfigStore } from '../../config/src/index.ts'

async function xlsxRows(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any)
  const rows: string[][] = [], sheet = wb.worksheets[0]
  sheet?.eachRow(row => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      while (cells.length < column - 1) cells.push('')
      const value = cell.value
      cells.push(value == null ? '' : typeof value === 'object' && !(value instanceof Date) ? String((value as any).result ?? (value as any).text ?? '') : String(value))
    }); rows.push(cells)
  })
  return rows
}

/** Existing semantic-update route, independently testable without application bootstrap. */
export function registerPointsImport(app: FastifyInstance, cfg: Pick<ConfigStore, 'importPoints'>) {
  app.post('/api/monitor_objects/:id/points/import', async (req, reply) => {
    const objectId = Number((req.params as { id: string }).id), body = req.body as any
    let points: unknown[], parse: unknown
    try {
      if (Array.isArray(body)) points = body
      else if (typeof body?.csv === 'string') { const result = smartParseCsv(body.csv, { partial: true }); points = result.points; parse = result.report }
      else if (typeof body?.xlsx === 'string') {
        let rows: string[][]
        try { rows = await xlsxRows(Buffer.from(body.xlsx, 'base64')) } catch { return reply.code(400).send({ error: '无法解析XLSX点表' }) }
        const result = smartParseTable(rows, { partial: true }); points = result.points; parse = result.report
      } else return reply.code(400).send({ error: 'expect a JSON array, { csv }, or { xlsx }' })
      const result = cfg.importPoints(objectId, points.map(normalizeSemanticPoint))
      return parse ? { ...result, parse } : result
    } catch (error: any) {
      const known = error.statusCode === 400 || error.statusCode === 404
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '语义点表导入失败，请核对配置状态，勿自动重复导入。' })
    }
  })
}
