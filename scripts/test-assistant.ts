import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import { registerAssistant } from '../packages/api/src/assistant.ts'

const dir = mkdtempSync(join(tmpdir(), 'probestation-ai-test-'))
const device: any = { id: 1, name: '台架', pollIntervalMs: 1000, timeoutMs: 3000 }
const reg = { id: 10, objectId: 1, groupId: 2, alias: '计数', dataType: 'uint32', functionCode: 3, startAddress: 0, factor: 1, offset: 0 }
const logs: string[] = []
const cfg = {
  getObject: (id: number) => id === 1 ? device : id === 3 ? { id: 3, name: '其他设备' } : undefined,
  listObjects: () => [device, { id: 3, name: '其他设备' }],
  listRegistersByObject: () => [reg], listGroups: () => [{ id: 2, objectId: 1 }],
  getRegister: (id: number) => id === 10 ? reg : undefined, getGroup: () => ({ id: 2, objectId: 1, isActive: 1 }),
  updateObject: (_id: number, fields: any) => Object.assign(device, fields),
  log: (...args: any[]) => logs.push(args.join(' ')),
}
const store = {
  getLatestByObjectAll: () => ({ 'holding-register:0': { rawValue: 1, timestamp: '2026-10-06 10:00:00', quality: 'good' }, 'holding-register:1': { rawValue: 2, timestamp: '2026-10-06 10:00:00', quality: 'good' } }),
  queryWithOffset: async (_id: number, address: number) => [{ ts: '2026-10-06 10:00:00', timestampMs: 1791242400000, rawValue: address === 0 ? 1 : 2, quality: 'good' }],
  statsByObject: async () => ({ totalRows: 2 }),
}
let responses: any[] = []
const sent: any[] = []
let mode = 'normal'
const fakeFetch: typeof fetch = async (_url, options) => {
  if (String(_url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-b' }, { id: 'test-a' }, { id: 'test-b' }] }))
  sent.push(JSON.parse(String(options?.body)))
  if (mode === 'error') return new Response('SECRET-PROVIDER-ERROR', { status: 401 })
  if (mode === 'wait') return new Promise((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
  return new Response(JSON.stringify({ choices: [{ message: responses.shift() ?? { content: '完成' } }] }), { status: 200 })
}
const call = (name: string, args: any) => ({ content: null, tool_calls: [{ id: 'call-' + Math.random(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const app = Fastify()
registerAssistant(app, { cfg, store, poller: { getDeviceDiagnostics: () => ({}), getDeviceFrames: () => [] } }, dir, fakeFetch)
const headers = { 'x-probestation-ai': '1' }
const request = async (method: any, url: string, payload?: any) => app.inject({ method, url: '/api/ai' + url, headers, ...(payload !== undefined ? { payload } : {}) })
async function session() { return (await request('POST', '/sessions', { deviceId: 1 })).json().id as string }
async function turn(id: string, tool: any, selection: any = {}) {
  responses = [tool, { content: '已分析；提案需要用户确认。' }]
  const r = await request('POST', `/sessions/${id}/messages`, { message: '执行测试', ...selection }); assert.equal(r.statusCode, 200)
  for (let n = 0; n < 100; n++) { const s = (await request('GET', `/sessions/${id}`)).json(); if (!s.running) return s; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('agent did not finish')
}
try {
  assert.equal((await app.inject({ url: '/api/ai/settings' })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/ai/settings', headers: { ...headers, origin: 'https://other.example' } })).statusCode, 403)
  assert.equal((await request('POST', '/settings', { baseUrl: 'http://remote.example', model: 'test' })).statusCode, 400)
  assert.equal((await request('POST', '/settings', { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'test-secret' })).statusCode, 200)
  const publicConfig = (await request('GET', '/settings')).body
  assert(!publicConfig.includes('test-secret')); assert(JSON.parse(publicConfig).hasKey)
  assert.equal(JSON.parse(readFileSync(join(dir, 'ai-settings.json'), 'utf8')).model, 'test')
  assert.deepEqual((await request('POST', '/models', {})).json().models, ['test-a', 'test-b'])
  assert.equal((await request('POST', '/settings', { baseUrl: 'https://model.example/v1', model: 'test', reasoningProtocol: 'invalid' })).statusCode, 400)
  const selectionId = await session()
  assert.equal((await request('POST', `/sessions/${selectionId}/messages`, { message: 'test', effort: 'high' })).statusCode, 400)
  await request('POST', '/settings', { baseUrl: 'https://model.example/v1', model: 'test', reasoningProtocol: 'reasoning_effort' })
  const readOnly = await turn(selectionId, call('propose_config_change', { target: 'device', target_id: 1, field: 'name', value: 'should-not-change' }), { mode: 'read', model: 'test-b', effort: 'high' })
  assert.equal(readOnly.proposals.length, 0)
  assert(readOnly.entries.some((e: any) => e.role === 'tool' && e.content.includes('只读问答')))
  assert.equal(sent.at(-1).model, 'test-b')
  assert.equal(sent.at(-1).reasoning_effort, 'high')
  assert(!sent.at(-1).tools.some((t: any) => t.function.name === 'propose_config_change'))
  await turn(selectionId, call('list_devices', {}))
  assert(!('reasoning_effort' in sent.at(-1)))
  const id = await session()
  let s = await turn(id, call('list_devices', {}))
  assert(s.entries.some((e: any) => e.role === 'tool' && e.content.includes('台架') && !e.content.includes('其他设备')))
  s = await turn(id, call('get_snapshot', { device_id: 1 }))
  assert(s.entries.at(-2).content.includes('65538'))
  s = await turn(id, call('get_snapshot', { device_id: 3 }))
  assert(s.entries.at(-2).content.includes('超出当前会话'))
  s = await turn(id, call('write_register', { device_id: 1, address: 0, value: 5 }))
  assert(s.entries.at(-2).content.includes('工具不在允许列表'))
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  assert(s.entries.at(-2).content.includes('65538'))
  const change = call('propose_config_change', { target: 'device', target_id: 1, field: 'pollIntervalMs', value: 500 })
  s = await turn(id, change)
  assert.equal(device.pollIntervalMs, 1000)
  let proposal = s.proposals.at(-1)
  assert.equal((await request('POST', `/sessions/${id}/messages`, { message: '绕过确认' })).statusCode, 400)
  assert.equal((await request('POST', `/sessions/${id}/proposals/${proposal.id}`, { accept: true, value: 1 })).statusCode, 200)
  assert.equal(device.pollIntervalMs, 500); assert(logs.length === 1)
  assert.equal((await request('POST', `/sessions/${id}/proposals/${proposal.id}`, { accept: true })).statusCode, 409)
  s = await turn(id, change); proposal = s.proposals.at(-1)
  device.pollIntervalMs = 750
  assert.equal((await request('POST', `/sessions/${id}/proposals/${proposal.id}`, { accept: true })).statusCode, 409)
  assert.equal(device.pollIntervalMs, 750)
  s = await turn(id, change); proposal = s.proposals.at(-1)
  assert.equal((await request('POST', `/sessions/${id}/proposals/${proposal.id}`, { accept: false })).statusCode, 200)
  assert.equal(device.pollIntervalMs, 750)
  s = await turn(id, call('propose_config_change', { target: 'device', target_id: 1, field: 'ip', value: 'other' }))
  assert(s.entries.at(-2).content.includes('不允许 AI 修改'))
  s = await turn(id, call('propose_config_change', { target: 'device', target_id: 1, field: 'pollIntervalMs', value: 0 }))
  assert(s.entries.at(-2).content.includes('超出范围'))
  mode = 'wait'
  await request('POST', `/sessions/${id}/messages`, { message: '长任务' })
  assert.equal((await request('POST', `/sessions/${id}/messages`, { message: '重复' })).statusCode, 409)
  await request('POST', `/sessions/${id}/stop`, {})
  await new Promise(r => setTimeout(r, 10))
  s = (await request('GET', `/sessions/${id}`)).json(); assert(!s.running); assert(s.error.includes('停止'))
  mode = 'error'
  s = await turn(id, { content: 'unused' }); assert(s.error.includes('401')); assert(!JSON.stringify(s).includes('SECRET-PROVIDER-ERROR'))
  assert(!sent.some(r => JSON.stringify(r).includes('test-secret')))
  await request('POST', '/settings', { baseUrl: 'https://different.example/v1', model: 'test' })
  assert.equal((await request('GET', '/settings')).json().hasKey, false)
  mode = 'normal'
  const compactId = await session()
  await turn(compactId, call('list_devices', {}))
  await turn(compactId, call('get_snapshot', { device_id: 1 }))
  const beforeCompact = (await request('GET', `/sessions/${compactId}`)).json()
  responses = [{ content: '用户正在查看设备数据；具体数值需要重新查询。' }]
  assert.equal((await request('POST', `/sessions/${compactId}/compact`, {})).statusCode, 200)
  async function waitCompact() { for (let i = 0; i < 100; i++) { const state = (await request('GET', `/sessions/${compactId}`)).json(); if (!state.running) return state; await new Promise(r => setTimeout(r, 5)) }; throw new Error('compact timeout') }
  const compacted = await waitCompact()
  assert(!compacted.error); assert(!compacted.compacting)
  assert.deepEqual(compacted.entries.slice(0, beforeCompact.entries.length), beforeCompact.entries)
  assert(compacted.entries.at(-1).content.includes('已压缩上下文'))
  await turn(compactId, { content: '继续' })
  assert(sent.at(-1).messages.some((m: any) => typeof m.content === 'string' && m.content.includes('较早对话摘要')))
  mode = 'error'
  await request('POST', `/sessions/${compactId}/compact`, {})
  assert((await waitCompact()).error.includes('原上下文已保留'))
  mode = 'normal'
  const emptyCompactId = await session()
  assert.equal((await request('POST', `/sessions/${emptyCompactId}/compact`, {})).statusCode, 400)
  const attachmentId = await session()
  const attachment = { name: 'sample.csv', data: Buffer.from('time,value\n1,25').toString('base64') }
  const attached = await turn(attachmentId, { content: '已读取附件' }, { attachments: [attachment] })
  assert(attached.entries.some((e: any) => e.content.includes('sample.csv')))
  assert(sent.at(-1).messages.some((m: any) => typeof m.content === 'string' && m.content.includes('time,value')))
  assert.equal((await request('POST', `/sessions/${attachmentId}/messages`, { message: 'test', attachments: Array(5).fill(attachment) })).statusCode, 400)
  assert.equal((await request('POST', `/sessions/${attachmentId}/messages`, { message: 'test', attachments: [{ name: 'fake.png', data: attachment.data }] })).statusCode, 400)
  assert.equal((await request('POST', `/sessions/${attachmentId}/messages`, { message: 'test', attachments: [{ name: 'large.txt', data: Buffer.alloc(20001, 65).toString('base64') }] })).statusCode, 400)
  const png = { name: 'plot.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
  await turn(attachmentId, { content: '图片已读取' }, { attachments: [png] })
  assert(sent.at(-1).messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url' && c.image_url.url.includes(png.data))))
  assert(!(await request('GET', `/sessions/${attachmentId}`)).body.includes(png.data))
  const catalog = (await request('GET', '/providers')).json()
  const native = catalog.providers.find((p: any) => p.id === 'minimax-cn').models[0]
  assert.equal((await request('POST', '/settings', { provider: 'minimax-cn', baseUrl: native.baseUrl, model: native.id, apiKey: 'native-secret' })).statusCode, 200)
  assert.equal((await request('GET', '/settings?provider=custom')).json().hasKey, false)
  assert.equal((await request('GET', '/settings?provider=minimax-cn')).json().hasKey, true)
  assert(!(await request('GET', '/providers')).body.includes('native-secret'))
  assert.equal((await request('POST', `/sessions/${id}/messages`, { provider: 'minimax-cn', model: 'wrong-model', message: 'test' })).statusCode, 400)
  await request('POST', '/settings', { provider: 'custom', baseUrl: 'https://different.example/v1', model: 'test' })
  assert.equal((await request('GET', '/settings?provider=minimax-cn')).json().hasKey, true)
  console.log('ASSISTANT TEST OK: scope, multiword reads, tool allowlist, proposals, confirmation, conflict, replay, cancellation, settings and secret isolation')
} finally {
  await app.close()
  if (resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')) rmSync(dir, { recursive: true, force: true })
}
