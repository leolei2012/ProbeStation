import type { FastifyInstance } from 'fastify'
import type { Sink } from '../../sink/src/index.ts'
import { HistoryExportLimitError } from '../../core/src/history-export-policy.ts'

/** Shared by the production API and isolated edition; never sends attachments on failure. */
export function registerHistoryExport(app: FastifyInstance, sink: Pick<Sink, 'exportCsv' | 'exportXlsx'>) {
  for (const format of ['csv', 'xlsx'] as const) app.get('/api/export/' + format, async (req, reply) => {
    const q = req.query as Record<string, string>, tz = Number(q.tz ?? 0)
    const ids = q.register_ids ? q.register_ids.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0) : undefined
    reply.header('Cache-Control', 'no-store')
    try {
      const result = await (format === 'csv' ? sink.exportCsv.bind(sink) : sink.exportXlsx.bind(sink))(Number(q.object_id), String(q.start), String(q.end), ids, Number.isFinite(tz) ? tz : 0)
      reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', `attachment; filename="export.${format}"`)
      return result
    } catch (error) {
      if (!(error instanceof HistoryExportLimitError)) throw error
      return reply.code(413).send({ code: error.code, limit: error.limit, error: `所选点位超过 ${error.limit} 条所需原始行，导出会被截断，已停止生成文件。请减少点位或缩小时间范围后重试。` })
    }
  })
}
