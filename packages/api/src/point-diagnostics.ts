import type { FastifyInstance } from 'fastify'
import { diagnoseDevicePoints } from '../../core/src/point-diagnostics.ts'

export function registerPointDiagnostics(app: FastifyInstance, cfg: any) {
  app.get('/api/monitor_objects/:id/point-diagnostics', async (req, reply) => {
    const raw = (req.params as { id: string }).id
    if (!/^\d+$/.test(raw)) return reply.code(400).send({ error: '设备 ID 无效' })
    try { return diagnoseDevicePoints(cfg, Number(raw)) }
    catch (error: any) {
      const known = error.statusCode === 400 || error.statusCode === 404
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '点表诊断失败' })
    }
  })
}
