import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
export function registerLogCleanup(app: FastifyInstance, cfg: Pick<ConfigStore, 'previewLogCleanup' | 'cleanupReviewedLogs'>) {
  app.get('/api/logs/cleanup-preview', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { return cfg.previewLogCleanup() } catch { return reply.code(503).send({ error: '日志清理范围暂时无法核实，请重新预览。' }) }
  })
  app.post('/api/logs/cleanup', { bodyLimit: 16384, preHandler: async (req, reply) => {
    let allowed = req.headers['x-probestation-config'] === '1'
    const origin = req.headers.origin
    if (origin !== undefined) { try { allowed = allowed && typeof origin === 'string' && new URL(origin).host === req.headers.host } catch { allowed = false } }
    if (!allowed) return reply.code(403).send({ error: '请从软件设置页面确认日志清理。' })
  } }, async (req, reply) => {
    try { return cfg.cleanupReviewedLogs(req.body) }
    catch (error: any) { const known = [400, 409].includes(error?.statusCode); return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '日志清理结果待核实，请检查后重新预览，勿自动重试。' }) }
  })
}
