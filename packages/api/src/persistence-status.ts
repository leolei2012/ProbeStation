import type { FastifyInstance } from 'fastify'
import type { DuckDBStore } from '../../store/src/index.ts'
import { parseSamplePersistence } from '../../core/src/sample-persistence.ts'
/** No database queries, flush, retry, cleanup or recovery action. */
export function registerPersistenceStatus(app: FastifyInstance, service: () => Pick<DuckDBStore, 'getSamplePersistenceStatus'> | null | undefined) {
  app.get('/api/storage/persistence-status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const raw = (request.query as { object_id?: unknown }).object_id
    if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return reply.code(400).send({ error: '落盘状态设备范围无效。' })
    const objectId = raw === undefined ? null : Number(raw)
    try { const store = service(); return store ? parseSamplePersistence(store.getSamplePersistenceStatus(objectId ?? undefined), objectId) : { version: 1, available: false, objectId } }
    catch { return reply.code(503).send({ error: '采样落盘状态暂时无法核实，请重新读取。' }) }
  })
}
