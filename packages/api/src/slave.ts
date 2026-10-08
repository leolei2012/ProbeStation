import type { FastifyInstance } from 'fastify'
import type { ModbusSlave, Transport } from '../../slave/src/index.ts'
import { SLAVE_AREAS, type SlaveArea } from '../../slave/src/protocol.ts'
export function registerSlave(app: FastifyInstance, slave?: ModbusSlave) {
  const service = () => { if (!slave) throw Object.assign(new Error('从站服务未启用'), { statusCode: 503 }); return slave }
  const transport = (value: unknown): Transport => { if (value !== 'tcp' && value !== 'rtu') throw Object.assign(new Error('请选择 TCP 或 RTU'), { statusCode: 400 }); return value }
  const area = (value: unknown): SlaveArea => { if (!SLAVE_AREAS.includes(value as SlaveArea)) throw Object.assign(new Error('数据区域无效'), { statusCode: 400 }); return value as SlaveArea }
  app.get('/api/slave', async () => service().status())
  app.post('/api/slave/start', async (req: any) => {
    const body = req.body ?? {}, fields: any = {}
    for (const key of ['host', 'port', 'unitId', 'serialPath', 'baudRate', 'parity', 'dataBits', 'stopBits']) if (body[key] !== undefined) fields[key] = body[key]
    return service().start(transport(body.transport), fields)
  })
  app.post('/api/slave/stop', async (req: any) => service().stop(transport(req.body?.transport)))
  app.get('/api/slave/values', async (req: any) => {
    const count = Number(req.query.count ?? 16)
    if (!Number.isInteger(count) || count < 1 || count > 200) throw Object.assign(new Error('每次读取 1–200 个值'), { statusCode: 400 })
    return { values: service().read(area(req.query.area), Number(req.query.address ?? 0), count) }
  })
  app.put('/api/slave/values', async (req: any) => {
    const b = req.body ?? {}
    if (!Array.isArray(b.values) || !b.values.length || b.values.length > 200) throw Object.assign(new Error('每次写入 1–200 个值'), { statusCode: 400 })
    const a = area(b.area); service().write(a, b.address, b.values)
    return { values: service().read(a, b.address, b.values.length) }
  })
}
