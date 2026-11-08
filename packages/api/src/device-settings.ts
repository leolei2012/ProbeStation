import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

export function registerDeviceSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'updateObjectSettings'> & Partial<Pick<ConfigStore, 'getConfigurationReadinessStatus'>>, runtime: { reconnect: (id: number) => Promise<unknown>; syncSlaves: () => Promise<unknown> }) {
  app.put('/api/monitor_objects/:id/settings', async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '设备编号无效。' })
    let result
    try {
      const state = cfg.getConfigurationReadinessStatus?.()
      // Only this pre-invocation rejection describes this request. Never infer it from a caught transaction error.
      if (state?.version === 1 && state.phase === 'quarantined' && state.failure === 'connection-quarantined') return reply.code(503).send({ error: '配置连接已隔离，本次保存未执行。请管理员核查并恢复，勿重复保存；之前请求结果仍须单独核实。', version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' })
      result = cfg.updateObjectSettings(Number(raw), request.body)
    }
    catch (error: any) {
      const known = [400, 404, 409].includes(error?.statusCode)
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '保存结果待核实，请核对配置，勿自动重复保存。' })
    }
    const warnings = [...result.warnings]
    // A committed configuration must not become a false write failure when runtime application fails.
    try { await runtime.reconnect(result.device.id) } catch { warnings.push('配置已保存，但连接重建未完成；请核对连接状态，勿重复保存配置。') }
    try { await runtime.syncSlaves() } catch { warnings.push('配置已保存，但从站同步未完成；请核对运行状态，勿重复保存配置。') }
    return { device: result.device, warnings }
  })
}
