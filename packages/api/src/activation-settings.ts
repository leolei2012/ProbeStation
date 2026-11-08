import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'

export function registerActivationSettings(app: FastifyInstance, cfg: Pick<ConfigStore, 'setActivation'>, runtime: { syncSlaves: () => Promise<unknown> }) {
  for (const [kind, path] of [['device', '/api/monitor_objects/:id/activation'], ['group', '/api/groups/:id/activation']] as const) {
    app.put(path, async (request, reply) => {
      const raw = (request.params as { id: string }).id
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return reply.code(400).send({ error: '开关编号无效。' })
      let result
      try { result = cfg.setActivation(kind, Number(raw), request.body) }
      catch (error: any) {
        const known = [400, 404, 409].includes(error?.statusCode)
        return reply.code(known ? error.statusCode : 500).send({ error: known ? error.message : '开关结果待核实，请刷新核对，勿直接重复切换。' })
      }
      const warnings = [...result.warnings]
      // Same runtime hook as the old device toggle, after commit. Never turn its failure into a false rejected write.
      if (kind === 'device') try { await runtime.syncSlaves() } catch { warnings.push('开关配置已保存，但从站同步未完成；请核对运行状态，勿重复切换。') }
      return { snapshot: result.snapshot, warnings }
    })
  }
}
