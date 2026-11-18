import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
import type { ModbusArea } from '../../core/src/protocol.ts'
import { deviceWriteRefusal } from '../../core/src/device-write-policy.ts'
import type { GuardedWritePlan } from '../../core/src/guarded-register-write.ts'
import type { BoundWriteOutcome } from '../../modbus/src/bound-write.ts'

interface WriteTarget {
  write(objectId: number, address: number, words: number[], method: 'single' | 'multiple', slaveId: number, area: ModbusArea): Promise<void>
  canWriteBoundRegisters?(): boolean
  writeBoundRegisters?(plan: GuardedWritePlan, accept: (send: () => void) => void): Promise<BoundWriteOutcome>
}
type WriteConfig = Pick<ConfigStore, 'getRegister' | 'getGroup' | 'log'> & Partial<Pick<ConfigStore, 'prepareRegisterWrite' | 'claimRegisterWrite' | 'getRegisterWrite' | 'acceptRegisterWrite' | 'finishRegisterWrite' | 'reviewUnknownRegisterWrite'>>
/** Legacy writes stay closed; only the versioned prepare/execute protocol can submit a bound command. */
export function registerRegisterWrite(app: FastifyInstance, _cfg: WriteConfig, _poller: WriteTarget) {
  app.post('/api/registers/:id/write', async (_req, reply) => reply.code(503).header('Cache-Control', 'no-store').send(deviceWriteRefusal()))
  const options = { preHandler: async (req: any, reply: any) => {
    let origin: string | undefined
    try { if (req.headers.origin) origin = new URL(req.headers.origin).host } catch { return reply.code(403).send({ error: '来源无效。' }) }
    if (req.headers['x-probestation-write'] !== '1' || origin && origin !== req.headers.host) return reply.code(403).send({ error: '请从写入确认弹窗操作。' })
    if (!_cfg.prepareRegisterWrite || !_poller.canWriteBoundRegisters?.() || !_poller.writeBoundRegisters) return reply.code(503).send({ error: '当前后台不支持来源绑定写入，请更新前后端。', code: 'BOUND_WRITE_UNAVAILABLE' })
    reply.header('Cache-Control', 'no-store')
  } }
  app.post<{ Params: { id: string } }>('/api/registers/:id/write/prepare', options, async req => {
    const body = req.body as any
    if (!body || body.version !== 1 || Object.keys(body).some(key => !['version', 'value', 'source'].includes(key))) throw Object.assign(new Error('写入准备参数无效。'), { statusCode: 400 })
    try { return _cfg.prepareRegisterWrite!(Number(req.params.id), body.value, body.source) }
    catch (error) { if (error instanceof Error && !('statusCode' in error)) throw Object.assign(error, { statusCode: 400 }); throw error }
  })
  app.get<{ Params: { id: string } }>('/api/register-writes/:id', options, async req => _cfg.getRegisterWrite!(req.params.id))
  app.post<{ Params: { id: string } }>('/api/register-writes/:id/execute', options, async req => {
    const body = req.body as any
    if (!body || body.version !== 1 || Object.keys(body).length !== 1) throw Object.assign(new Error('执行时不能改变来源、值或方法，请重新准备。'), { statusCode: 400 })
    const { operation, claimed } = _cfg.claimRegisterWrite!(req.params.id)
    if (!claimed) return operation // duplicate submission only returns the existing outcome; never sends again
    let entered = false
    try {
      const result = await _poller.writeBoundRegisters!(operation.plan, send => {
        if (entered) throw new Error('同一计划不能重复提交。')
        _cfg.acceptRegisterWrite!(operation.plan, () => { entered = true; send() })
      })
      return _cfg.finishRegisterWrite!(operation.id, result.state, result.message)
    } catch (error) {
      // If journaling itself fails, the durable 'sending' state remains unresolved; no retry.
      return _cfg.finishRegisterWrite!(operation.id, entered ? 'unknown' : 'not-sent', String(error) + (entered ? '；写入可能已执行，不重发。' : '；未发送。'))
    }
  })
  app.post<{ Params: { id: string } }>('/api/register-writes/:id/review-unknown', options, async req => {
    if ((req.body as any)?.confirmedOnSite !== true || Object.keys(req.body as object).length !== 1) throw Object.assign(new Error('请先现场核实原操作结果。'), { statusCode: 400 })
    return _cfg.reviewUnknownRegisterWrite!(req.params.id)
  })
}
