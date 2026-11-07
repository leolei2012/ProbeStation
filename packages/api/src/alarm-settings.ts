import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
export function registerAlarmSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'updateRuleSettings' | 'deleteRuleSettings'>) {
  for (const method of ['PUT', 'DELETE'] as const) app.route({ method, url: '/api/rules/:id/settings', handler: async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '告警编号无效。' })
    try { return method === 'PUT' ? cfg.updateRuleSettings(Number(raw), request.body) : cfg.deleteRuleSettings(Number(raw), request.body) }
    catch (error: any) {
      const known = [400, 404, 409].includes(error?.statusCode)
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '告警操作结果待核实，请重新读取核对，勿自动重试。' })
    }
  } })
}
