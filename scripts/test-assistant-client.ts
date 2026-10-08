import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { assistantRequest } from '../apps/web/src/assistant-client'
const app = Fastify()
app.delete('/api/ai/settings/custom', async () => ({ ok: true }))
app.post('/api/ai/settings', async req => req.body)
app.get('/api/ai/failure', async (_, reply) => reply.code(409).send({ error: 'Conflict', message: '请先停止当前任务' }))
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, init) => {
    const result = await app.inject({ method: init?.method as any, url: String(url), headers: init?.headers as any, ...(init?.body !== undefined ? { payload: String(init.body) } : {}) })
    return new Response(result.body, { status: result.statusCode })
  }
  assert.deepEqual(await assistantRequest('/settings/custom', undefined, 'DELETE'), { ok: true })
  assert.deepEqual(await assistantRequest('/settings', { model: 'test' }), { model: 'test' })
  await assert.rejects(assistantRequest('/failure'), /请先停止当前任务/)
  console.log('ASSISTANT CLIENT TEST OK: bodyless DELETE, JSON POST, readable errors')
} finally { globalThis.fetch = originalFetch; await app.close() }
