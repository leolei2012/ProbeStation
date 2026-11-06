import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

export function registerGroupSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'getGroupSettings' | 'updateGroupSettings'>) {
  const id = (raw: string) => /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 0
  app.get('/api/groups/:id/settings', async (request, reply) => {
    try { return cfg.getGroupSettings(id((request.params as { id: string }).id)) }
    catch (error: any) { return reply.code([400, 404, 409].includes(error?.statusCode) ? error.statusCode : 500).send({ error: [400, 404, 409].includes(error?.statusCode) ? error.message : '分组快照读取失败，请重试或核对配置。' }) }
  })
  app.put('/api/groups/:id/settings', async (request, reply) => {
    try { return cfg.updateGroupSettings(id((request.params as { id: string }).id), request.body) }
    catch (error: any) { return reply.code([400, 404, 409].includes(error?.statusCode) ? error.statusCode : 500).send({ error: [400, 404, 409].includes(error?.statusCode) ? error.message : '保存结果待核实，请核对配置，勿自动重复保存。' }) }
  })
}
