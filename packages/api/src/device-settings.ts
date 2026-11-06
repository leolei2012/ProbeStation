import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

export function registerDeviceSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'updateObjectSettings'>, runtime: { reconnect: (id: number) => Promise<unknown>; syncSlaves: () => Promise<unknown> }) {
  app.put('/api/monitor_objects/:id/settings', async (request, reply) => {
    const raw = (request.params as { id: string }).id
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '设备编号无效。' })
    let result
    try { result = cfg.updateObjectSettings(Number(raw), request.body) }
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
