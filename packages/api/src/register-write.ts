import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
import { areaForFunction, encodeRegister, type ModbusArea, type ModbusFunctionCode } from '../../core/src/index.ts'
import { parseRegisterWriteValue } from '../../core/src/register-write-value.ts'

interface WriteTarget { write(objectId: number, address: number, words: number[], method: 'single' | 'multiple', slaveId: number, area: ModbusArea): Promise<void> }
/** Registration only. Tests inject a mock target; importing this module never starts a device/service. */
export function registerRegisterWrite(app: FastifyInstance, cfg: Pick<ConfigStore, 'getRegister' | 'getGroup' | 'log'>, poller: WriteTarget) {
  app.post('/api/registers/:id/write', async (req, reply) => {
    const id = Number((req.params as { id: string }).id), reg = cfg.getRegister(id)
    if (!reg) return { code: 404, error: 'register not found' }
    const body = req.body as { value?: unknown; method?: unknown } | null | undefined
    let value: number | bigint, words: number[]
    try { value = parseRegisterWriteValue(reg.dataType ?? 'int16', body?.value); words = encodeRegister(reg.dataType ?? 'int16', value) }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }) }
    const requested = body?.method === 'single' ? 'single' : 'multiple', method = words.length > 1 ? 'multiple' : requested
    const group = cfg.getGroup(reg.groupId), area = areaForFunction(reg.functionCode as ModbusFunctionCode)
    await poller.write(reg.objectId, reg.startAddress, words, method, group?.slaveId ?? 1, area)
    cfg.log('INFO', 'api', 'write register ' + id + ' = ' + String(value) + ' (' + reg.dataType + ', ' + words.length + ' word(s))')
    return { register_id: id, value: String(value), dataType: reg.dataType, method, words }
  })
}
