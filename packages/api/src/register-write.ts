import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../../config/src/index.ts'
import type { ModbusArea } from '../../core/src/protocol.ts'
import { deviceWriteRefusal } from '../../core/src/device-write-policy.ts'

interface WriteTarget { write(objectId: number, address: number, words: number[], method: 'single' | 'multiple', slaveId: number, area: ModbusArea): Promise<void> }
/** No config access, logging, target dispatch or runtime unlock on this route. */
export function registerRegisterWrite(app: FastifyInstance, _cfg: Pick<ConfigStore, 'getRegister' | 'getGroup' | 'log'>, _poller: WriteTarget) {
  app.post('/api/registers/:id/write', async (_req, reply) => reply.code(503).header('Cache-Control', 'no-store').send(deviceWriteRefusal()))
}
