import type { FastifyInstance } from 'fastify'
import { parseRecordingIntervalStatus, type RecordingIntervalStatus } from '../../core/src/recording-attention.ts'

/** Metadata only: no start/stop/restore endpoint and no service bootstrap. */
export function registerRecordingAttention(app: FastifyInstance, service: () => { getRecordingIntervalStatus(id: number): RecordingIntervalStatus } | null | undefined) {
  app.get('/api/monitor_objects/:id/recording-interval-status', async (request, reply) => {
    const raw = (request.params as { id: string }).id, id = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) return reply.code(400).send({ error: '设备编号无效。' })
    try { const current = service(); return current ? parseRecordingIntervalStatus(current.getRecordingIntervalStatus(id), id) : { available: false, deviceId: id } }
    catch { return reply.code(500).send({ error: '录制间隔状态未核实，请重新读取。' }) }
  })
}
