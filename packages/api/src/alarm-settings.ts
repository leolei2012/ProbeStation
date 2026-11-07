import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
export function registerAlarmSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'updateRuleSettings' | 'deleteRuleSettings' | 'createRuleSettings' | 'getAlarmEditContext'>) {
  const errorReply = (reply: any, error: any, read = false) => {
    const known = [400, 404, 409].includes(error?.statusCode)
    return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : read ? '告警条件读取失败，请重读；本次未修改配置。' : '告警操作结果待核实，请重新读取核对，勿自动重试。' })
  }
  app.post('/api/rules/settings', async (request, reply) => { try { return cfg.createRuleSettings(request.body) } catch (error) { return errorReply(reply, error) } })
  for (const kind of ['rule', 'register'] as const) app.get(kind === 'rule' ? '/api/rules/:id/settings' : '/api/registers/:id/alarm-context', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '告警/点位编号无效。' })
    try { return cfg.getAlarmEditContext(kind === 'rule' ? { ruleId: Number(raw) } : { registerId: Number(raw) }) } catch (error) { return errorReply(reply, error, true) }
  })
  for (const method of ['PUT', 'DELETE'] as const) app.route({ method, url: '/api/rules/:id/settings', handler: async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '告警编号无效。' })
    try { return method === 'PUT' ? cfg.updateRuleSettings(Number(raw), request.body) : cfg.deleteRuleSettings(Number(raw), request.body) }
    catch (error) { return errorReply(reply, error) }
  } })
}
