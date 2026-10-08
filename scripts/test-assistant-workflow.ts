import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import { registerAssistant } from '../packages/api/src/assistant'
import { chatResponse } from '../packages/api/src/assistant-stream'

const dir = mkdtempSync(join(tmpdir(), 'probe-workflow-'))
const d = { id: 1, name: '测试设备', isActive: 1, pollIntervalMs: 1000, timeoutMs: 1000 }
const reg = { id: 10, groupId: 2, objectId: 1, alias: '温度', dataType: 'uint16', functionCode: 3, startAddress: 0 }
let now = Date.now(), connected = true, reply: any = { content: '完成' }, status = 200
const bodies: any[] = []
let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
let streaming = false
const encoder = new TextEncoder()
const event = (delta: any, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const fake: typeof fetch = async (_url, options) => {
  const body = JSON.parse(String(options?.body)); bodies.push(body)
  if (status !== 200) return new Response('SECRET', { status })
  if (streaming && body.stream) return new Response(new ReadableStream({ start(c) { streamController = c; options?.signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }) } }), { headers: { 'content-type': 'text/event-stream' } })
  const summary = body.messages[0]?.content?.includes('对话摘要器')
  const message = summary ? { content: '保留设备 1 的目标与已验证事实。' } : reply
  reply = { content: '完成' }
  return Response.json({ choices: [{ message }] })
}
const services = {
  cfg: { listObjects: () => [d], getObject: (id: number) => id === 1 ? d : null, listGroups: () => [{ id: 2, name: '测试组', isActive: 1, quantity: 1, functionCode: 3 }], getGroup: () => ({ id: 2, name: '测试组' }), listRegistersByObject: () => [reg], getRegister: () => reg, updateObject: (_id: number, fields: any) => Object.assign(d, fields), log: () => {} },
  store: { getLatestByObjectAll: () => ({ 'holding-register:0': { rawValue: 23, timestampMs: now, quality: 'good' } }), queryWithOffset: async () => [{ timestampMs: now, ts: new Date(now).toISOString(), rawValue: 23, quality: 'good' }] },
  poller: { getDeviceDiagnostics: () => ({ connected }), getDeviceFrames: () => [] },
}
let app = Fastify()
const start = () => registerAssistant(app, services, dir, fake)
start()
const req = (method: any, path: string, payload?: any) => app.inject({ method, url: '/api/ai' + path, headers: { 'x-probestation-ai': '1' }, ...(payload === undefined ? {} : { payload }) })
const settle = async (id: string) => {
  for (let i = 0; i < 200; i++) { const s = (await req('GET', '/sessions/' + id)).json(); if (!s.running) return s; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('Task did not settle')
}
const call = (name: string, args: any) => ({ content: null, tool_calls: [{ id: 'test-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
try {
  await req('POST', '/settings', { provider: 'custom', baseUrl: 'https://test.invalid/v1', model: 'test', apiKey: 'test-secret' })
  assert.equal((await req('POST', '/test', { provider: 'custom', baseUrl: 'https://test.invalid/v1', model: 'test' })).json().ok, true)
  assert(!JSON.stringify(bodies.at(-1)).includes('测试设备'))
  for (const code of [401, 404, 429, 503]) { status = code; const r = await req('POST', '/test', { provider: 'custom', baseUrl: 'https://test.invalid/v1', model: 'test' }); assert.equal(r.statusCode, 400); assert(r.body.includes(String(code))); assert(!r.body.includes('SECRET')) }
  status = 200
  assert.equal((await req('GET', '/issues')).json().issues.length, 0)
  now -= 60000; assert((await req('GET', '/issues')).json().issues[0].reason.includes('过期'))
  connected = false; assert.equal((await req('GET', '/issues')).json().issues[0].view, 'diagnostics')
  d.isActive = 0; assert((await req('GET', '/issues')).json().issues[0].reason.includes('暂停'))
  d.isActive = 1; connected = true; now = Date.now()
  const id = (await req('POST', '/sessions', { deviceId: 1 })).json().id
  const send = () => req('POST', `/sessions/${id}/messages`, { message: '测试' })
  streaming = true; await send()
  assert(streamController)
  streamController!.enqueue(encoder.encode(event({ content: '第一段' })))
  await new Promise(r => setTimeout(r, 20))
  const partial = (await req('GET', '/sessions/' + id)).json()
  assert(partial.running); assert.equal(partial.partial, '第一段')
  streamController!.enqueue(encoder.encode(event({ content: '第二段' }, 'stop') + 'data: [DONE]\n\n')); streamController!.close()
  assert.equal((await settle(id)).entries.at(-1).content, '第一段第二段')
  streaming = false
  reply = call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: new Date(now - 60000).toISOString(), end: new Date(now).toISOString() })
  await send(); const sourced = await settle(id)
  assert.equal(sourced.sources[0].registerId, 10); assert.equal(sourced.sources[0].view, 'history')
  reply = call('propose_config_change', { target: 'device', target_id: 1, field: 'pollIntervalMs', value: 500 })
  await send(); const proposed = await settle(id), pid = proposed.proposals[0].id
  assert.equal((await req('POST', `/sessions/${id}/proposals/${pid}`, { accept: true })).json().proposals[0].state, 'applied')
  d.pollIntervalMs = 800
  assert.equal((await req('POST', `/sessions/${id}/proposals/${pid}/undo`, {})).statusCode, 409)
  assert.equal(d.pollIntervalMs, 800)
  d.pollIntervalMs = 500
  assert.equal((await req('POST', `/sessions/${id}/proposals/${pid}/undo`, {})).json().proposals[0].state, 'undone')
  assert.equal(d.pollIntervalMs, 1000)
  assert.equal((await req('POST', `/sessions/${id}/proposals/${pid}/undo`, {})).statusCode, 409)
  await app.close()
  const file = join(dir, 'ai-sessions', id + '.json'), saved = JSON.parse(readFileSync(file, 'utf8'))
  assert(!readFileSync(file, 'utf8').includes('test-secret'))
  saved.messages.push({ role: 'user', content: '请求时间：旧请求' }, { role: 'assistant', content: '历史查询数据'.repeat(18000) })
  writeFileSync(file, JSON.stringify(saved))
  app = Fastify(); start()
  assert.equal((await req('GET', '/sessions/' + id)).json().proposals[0].state, 'undone')
  await send(); const compacted = await settle(id)
  assert(!compacted.error, compacted.error)
  assert(compacted.entries.some((e: any) => e.content.includes('已压缩上下文')))
  assert(bodies.at(-1).messages.some((m: any) => m.content?.includes('较早对话摘要')))
  assert(compacted.entries.some((e: any) => e.content === '第一段第二段'))
  // A truncated stream must never be promoted into a completed assistant answer.
  const truncated = new Response(event({ content: '不完整' }), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(chatResponse(truncated, new AbortController().signal), /未完成/)
  const fragmented = event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'list_devices', arguments: '{' } }] }) + event({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, 'tool_calls')
  const parsed = await chatResponse(new Response(fragmented, { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal)
  assert.equal(parsed.tool_calls[0].function.arguments, '{}')
  streaming = true; await send(); await req('POST', `/sessions/${id}/stop`, {})
  assert.equal((await settle(id)).turns.at(-1).state, 'stopped')
  await app.close()
  const interrupted = JSON.parse(readFileSync(file, 'utf8'))
  interrupted.running = true
  interrupted.turns.at(-1).state = 'running'
  interrupted.proposals.push({ id: 'interrupted-proposal', state: 'pending' })
  writeFileSync(file, JSON.stringify(interrupted))
  app = Fastify(); start()
  const recovered = (await req('GET', '/sessions/' + id)).json()
  assert.equal(recovered.running, false)
  assert.equal(recovered.turns.at(-1).state, 'stopped')
  assert.equal(recovered.proposals.at(-1).state, 'cancelled')
  assert(recovered.error.includes('重启'))
  console.log('WORKFLOW OK: streaming, interruption, restart recovery, automatic compaction, sources, issues, connection errors and undo conflict protection')
} finally {
  await app.close()
  assert(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'))
  rmSync(dir, { recursive: true, force: true })
}
