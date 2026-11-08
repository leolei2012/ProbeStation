import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from 'cordis'
import type {} from '../packages/api/src/events.ts'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerAssistant } from '../packages/api/src/assistant.ts'

// Compile-only contract checks. Never invoke event emission in this function.
function checkEventTypes(ctx: Context) {
  ctx.emit('poller/result', { objectId: 1, points: [] })
  ctx.emit('poller/group-ok', { groupId: 2 })
  ctx.emit('poller/group-ok', { objectId: 1, groupId: 2 })
  ctx.emit('poller/group-error', { objectId: 1, groupId: 2, error: 'synthetic' })
  ctx.emit('device/status', { objectId: 1, connected: false, error: 'synthetic' })
  ctx.emit('rule/trigger', { ruleId: 1, objectId: 1, registerId: 2, value: '9007199254740993', operator: '>', threshold: 0, message: null })
  // @ts-expect-error Device identity is numeric, not an arbitrary string.
  ctx.emit('poller/result', { objectId: '1', points: [] })
  // @ts-expect-error The samples envelope is an array, not any value.
  ctx.emit('poller/result', { objectId: 1, points: {} })
  // @ts-expect-error Group identity remains required in the legacy recovery form.
  ctx.emit('poller/group-ok', { objectId: 1 })
  // @ts-expect-error A driver status must report a boolean.
  ctx.emit('device/status', { objectId: 1, connected: 'yes' })
  // @ts-expect-error Group errors carry a message.
  ctx.emit('poller/group-error', { objectId: 1, groupId: 2 })
  // @ts-expect-error A rule trigger cannot omit its rule identity.
  ctx.emit('rule/trigger', { objectId: 1, registerId: 2, value: 1, operator: '>', threshold: 0, message: null })
}
void checkEventTypes // Keep the checks type-visible without executing them.

const directory = mkdtempSync(join(tmpdir(), 'probestation-api-types-')), cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify()
let fetches = 0
const fetcher: typeof fetch = async () => { fetches++; return new Response(JSON.stringify({ data: {} }), { headers: { 'Content-Type': 'application/json' } }) }
try {
  registerAssistant(app, { cfg, store: {}, poller: {} }, directory, fetcher)
  const send = (method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>) => app.inject({ method, url: '/api/ai' + path, payload, headers: { 'x-probestation-ai': '1' } })
  assert.equal((await send('GET', '/sessions/synthetic-missing-session')).statusCode, 404)
  assert.equal((await send('POST', '/models', { provider: 'synthetic-unknown' })).statusCode, 400); assert.equal(fetches, 0)
  const invalidCatalog = await send('POST', '/models', { provider: 'custom', baseUrl: 'https://mock.invalid/v1' })
  assert.equal(invalidCatalog.statusCode, 400); assert.equal(fetches, 1)
  assert.equal((await send('POST', '/settings', { baseUrl: 'https://mock.invalid/v1', model: 'synthetic-model' })).statusCode, 200)
  const session = (await send('POST', '/sessions', {})).json()
  assert.equal((await send('POST', `/sessions/${session.id}/messages`, { message: 'synthetic', attachments: [null] })).statusCode, 400)
  const missingProposal = await send('POST', `/sessions/${session.id}/proposals/synthetic-missing-proposal`, { accept: true })
  assert.equal(missingProposal.statusCode, 409); assert.equal(missingProposal.json().message, '修改不存在或已处理')
  const after = (await send('GET', '/sessions/' + session.id)).json()
  assert.equal(after.running, false); assert.equal(after.entries.length, 0); assert.equal(after.proposals.length, 0)
  assert.equal(fetches, 1, 'rejections must not reach a model or retry the mock metadata fetch')
  assert.equal(cfg.listObjects().length, 0)
} finally {
  await app.close(); cfg.close()
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(directory.startsWith(join(tmpdir(), 'probestation-api-types-')))
  rmSync(directory, { recursive: true, force: true })
}
console.log('API TYPES OK: positive/negative event envelopes compile; real assistant routes retain 400/404/409 rejection and unchanged state with injected metadata response; no listener, model, hardware, real database or network')
