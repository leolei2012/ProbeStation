import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

/** No hardware/service hooks. Existing unguarded CRUD remains compatible for older callers. */
export function registerPointSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'updateRegisterSettings'>) {
  app.put('/api/registers/:id/settings', async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '点位编号无效。' })
    try { return cfg.updateRegisterSettings(Number(raw), request.body) }
    catch (error: any) {
      const known = [400, 404, 409].includes(error?.statusCode)
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '保存结果待核实，请核对配置，勿自动重复保存。' })
    }
  })
}
