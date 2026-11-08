import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

/** No hardware/service hooks. Existing unguarded CRUD remains compatible for older callers. */
export function registerPointSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'getRegisterSettings' | 'updateRegisterSettings'> & Partial<Pick<ConfigStore, 'getConfigurationReadinessStatus'>>) {
  app.get('/api/registers/:id/settings', async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '点位编号无效。' })
    try { return { expected: cfg.getRegisterSettings(Number(raw)) } }
    catch (error: any) {
      const known = [400, 404, 409].includes(error?.statusCode)
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '点位快照读取失败，请核对后重读。' })
    }
  })
  app.put('/api/registers/:id/settings', async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '点位编号无效。' })
    try {
      const state = cfg.getConfigurationReadinessStatus?.()
      if (state?.version === 1 && state.phase === 'quarantined' && state.failure === 'connection-quarantined') return reply.code(503).send({ error: '配置连接已隔离，本次保存未执行。请管理员核查并恢复，勿重复保存；之前请求结果仍须单独核实。', version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' })
      return cfg.updateRegisterSettings(Number(raw), request.body)
    }
    catch (error: any) {
      const known = [400, 404, 409].includes(error?.statusCode)
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '保存结果待核实，请核对配置，勿自动重复保存。' })
    }
  })
}
