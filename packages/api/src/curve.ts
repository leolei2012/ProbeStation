import type { FastifyInstance } from 'fastify'
import { isBinType, isHexType, registerWidth } from '@probebench/core'

export function registerCurve(app: FastifyInstance, cfg: any, store: any) {
  app.get('/api/data/object/series', async (req, reply) => {
    const q = req.query as Record<string, string>
    const id = Number(q.object_id), start = Date.parse(q.start), end = Date.parse(q.end)
    const maxPoints = q.max_points === undefined ? 1200 : Number(q.max_points)
    if (!Number.isSafeInteger(id) || !cfg.getObject(id)) return reply.code(404).send({ error: '设备不存在' })
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isInteger(maxPoints) || maxPoints < 5 || maxPoints > 25000) return reply.code(400).send({ error: '时间范围或显示点数无效' })
    const ids = q.register_ids === undefined ? null : q.register_ids === '' ? [] : q.register_ids.split(',').map(Number)
    if (ids?.some(n => !Number.isSafeInteger(n) || n < 1)) return reply.code(400).send({ error: '点位 ID 无效' })
    const all = cfg.listRegisters(id)
    if (ids?.some(n => !all.some((r: any) => r.id === n))) return reply.code(400).send({ error: '点位不属于当前设备' })
    const regs = cfg.listGroups(id).flatMap((g: any) => {
      let covered = -1
      return all.filter((r: any) => r.groupId === g.id).sort((a: any, b: any) => a.startAddress - b.startAddress).filter((r: any) => {
        if (r.startAddress < covered) return false
        covered = r.startAddress + registerWidth(r.dataType)
        return covered <= g.startAddress + g.quantity && !isHexType(r.dataType) && !isBinType(r.dataType) && (ids === null || ids.includes(r.id))
      })
    })
    const controller = new AbortController()
    const close = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.on('close', close)
    try { return await store.queryRegisterCurve(id, new Date(start).toISOString(), new Date(end).toISOString(), regs, maxPoints, controller.signal) }
    finally { reply.raw.off('close', close) }
  })
}
