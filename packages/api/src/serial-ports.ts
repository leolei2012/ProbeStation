import type { FastifyInstance } from 'fastify'
import { listSystemSerialPorts, sanitizeSerialPorts, type SerialPortMetadata } from '../../modbus/src/serial-ports.ts'

export function registerSerialPorts(app: FastifyInstance, list: () => Promise<SerialPortMetadata[]> = listSystemSerialPorts, source: 'system' | 'mock' = 'system') {
  app.get('/api/serial-ports', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { return { ports: sanitizeSerialPorts(await list()), source, location: 'backend', enumerationOnly: true } }
    catch { return reply.code(503).send({ error: '无法枚举后端电脑的串口。请刷新重试或手工输入路径。', source, location: 'backend', enumerationOnly: true }) }
  })
}
