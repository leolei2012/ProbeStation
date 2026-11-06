import type { FastifyInstance } from 'fastify'
import { planHistoryCurve } from '@probebench/core'
import { withRegisterSources } from '../../core/src/sample-source.ts'

export function registerCurve(app: FastifyInstance, cfg: any, store: any) {
  app.get('/api/data/object/curve', (_req, reply) => reply.code(410).send({ error: '旧版逐地址聚合不保留响应身份，已停用；请使用 /api/data/object/series。' }))
  app.get('/api/data/object/series', async (req, reply) => {
    const q = req.query as Record<string, string>
    const id = Number(q.object_id), start = Date.parse(q.start), end = Date.parse(q.end)
    const maxPoints = q.max_points === undefined ? 1200 : Number(q.max_points)
    const device = Number.isSafeInteger(id) ? cfg.getObject(id) : null
    if (!device) return reply.code(404).send({ error: '设备不存在' })
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isInteger(maxPoints) || maxPoints < 5 || maxPoints > 25000) return reply.code(400).send({ error: '时间范围或显示点数无效' })
    const ids = q.register_ids === undefined ? null : q.register_ids === '' ? [] : q.register_ids.split(',').map(Number)
    if (ids?.some(n => !Number.isSafeInteger(n) || n < 1)) return reply.code(400).send({ error: '点位 ID 无效' })
    const groups = cfg.listGroups(id)
    const all = withRegisterSources<any>(cfg.listRegistersByObject(id), groups, device)
    if (ids?.some(n => !all.some((r: any) => r.id === n))) return reply.code(400).send({ error: '点位不属于当前设备' })
    // Keep the existing store port's fresh mutable array, separate from the immutable explanation.
    const regs = [...planHistoryCurve(groups, all, ids).registers]
    const controller = new AbortController()
    const close = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.on('close', close)
    try { return await store.queryRegisterCurve(id, new Date(start).toISOString(), new Date(end).toISOString(), regs, maxPoints, controller.signal) }
    finally { reply.raw.off('close', close) }
  })
}
