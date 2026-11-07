import type { FastifyInstance } from 'fastify'
import { diagnosticToken } from '../../core/src/diagnostics-cleanup.ts'
import { DiagnosticsCleanupRefused } from '../../poller/src/diagnostics-cleanup.ts'
export function registerDiagnosticsCleanup(app: FastifyInstance, poller: { previewDiagnosticsCleanup: (id: number) => unknown; clearReviewedDiagnostics: (id: number, token: string) => unknown }) {
  const idOf = (request: any) => { const id = Number(request.params.id); if (!Number.isSafeInteger(id) || id < 1) throw new DiagnosticsCleanupRefused(); return id }
  app.get('/api/monitor_objects/:id/diagnostics/cleanup-preview', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { return poller.previewDiagnosticsCleanup(idOf(req)) } catch { return reply.code(503).send({ error: '诊断清空目标暂时无法核实，请稍后重新预览。' }) }
  })
  app.post('/api/monitor_objects/:id/diagnostics/cleanup', { bodyLimit: 16384, preHandler: async (req, reply) => {
    let allowed = req.headers['x-probestation-config'] === '1'
    if (req.headers.origin !== undefined) { try { allowed = allowed && new URL(req.headers.origin).host === req.headers.host } catch { allowed = false } }
    if (!allowed) return reply.code(403).send({ error: '请从软件界面确认诊断清空。' })
  } }, async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'token' || !diagnosticToken(body.token)) return reply.code(400).send({ error: '诊断清空条件无效。' })
    try { return poller.clearReviewedDiagnostics(idOf(req), body.token) }
    catch (error) { return reply.code(error instanceof DiagnosticsCleanupRefused ? 409 : 500).send({ error: error instanceof DiagnosticsCleanupRefused ? '目标或条件已失效，未追加执行清空；请重新预览。' : '诊断清空结果待核实，可能已执行；勿自动重试。' }) }
  })
}
