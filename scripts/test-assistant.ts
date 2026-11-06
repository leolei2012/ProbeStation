import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import { registerAssistant, assistantTools } from '../packages/api/src/assistant.ts'

const dir = mkdtempSync(join(tmpdir(), 'probestation-ai-test-'))
const device: any = { id: 1, name: '台架', pollIntervalMs: 1000, timeoutMs: 3000 }
const reg = { id: 10, objectId: 1, groupId: 2, alias: '计数', dataType: 'uint32', functionCode: 3, startAddress: 0, factor: 1, offset: 0 }
const logs: string[] = []
let historyCount = 1
let historyBatchMode: 'legacy' | 'verified' | 'mixed' = 'legacy'
let historySlaveId: number | null = 1
let snapshotMode: 'verified' | 'legacy' | 'unknown' | 'other' = 'verified'
let ambiguousAddress = false
const historyRequests: Array<number | undefined> = []
const cfg = {
  getObject: (id: number) => id === 1 ? device : id === 3 ? { id: 3, name: '其他设备' } : undefined,
  listObjects: () => [device, { id: 3, name: '其他设备' }],
  listRegistersByObject: () => ambiguousAddress ? [reg, { ...reg, id: 11, groupId: 3 }] : [reg], listGroups: () => [{ id: 2, objectId: 1, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 2 }, ...(ambiguousAddress ? [{ id: 3, objectId: 1, slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2 }] : [])],
  getRegister: (id: number) => id === 10 ? reg : undefined, getGroup: () => ({ id: 2, objectId: 1, isActive: 1 }),
  updateObject: (_id: number, fields: any) => Object.assign(device, fields),
  log: (...args: any[]) => logs.push(args.join(' ')),
}
const store = {
  getLatestByObjectAll: () => Object.fromEntries([0, 1].map(address => ['holding-register:' + address, { rawValue: address ? 2 : 1, timestamp: '2026-10-06 10:00:00', slaveId: snapshotMode === 'unknown' ? null : snapshotMode === 'other' ? 2 : 1, quality: 'good', batchId: snapshotMode === 'legacy' ? null : 'snapshot' }])),
  queryWithOffset: async (_id: number, address: number, _start: string, _end: string, _area: string, _limit: number, _offset: number, slaveId?: number) => { historyRequests.push(slaveId); return Array.from({ length: historyCount }, (_, i) => ({ ts: '2026-10-06 10:00:00', timestampMs: 1791242400000 + i, rawValue: address === 0 ? historySlaveId === 2 ? 2 : 1 : 2, slaveId: historySlaveId, quality: 'good', batchId: historyBatchMode === 'legacy' ? null : `response-${i}-${historyBatchMode === 'mixed' ? address : 'same'}` })) },
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
  const snapshotOutput = () => JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n')).points[0]
  assert.equal(snapshotOutput().rawDecodedValue, 65538); assert.equal(snapshotOutput().automaticEligible, true)
  snapshotMode = 'legacy'; s = await turn(id, call('get_snapshot', { device_id: 1 }))
  assert.equal(snapshotOutput().rawDecodedValue, null); assert.equal(snapshotOutput().compatibilityValue, 65538)
  assert.equal(snapshotOutput().automaticEligible, false)
  for (const kind of ['unknown', 'other'] as const) {
    snapshotMode = kind; s = await turn(id, call('get_snapshot', { device_id: 1 }))
    assert.equal(snapshotOutput().rawDecodedValue, null); assert.equal(snapshotOutput().verification, 'unknown')
  }
  snapshotMode = 'verified'

  historyCount = 600
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-01T00:00:00Z', end: '2026-10-10T00:00:00Z' }))
  const completeHistory = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(completeHistory.points.length, 600)
  assert.equal(completeHistory.truncated, false)
  assert.equal(completeHistory.count, 0, 'legacy compatibility values never enter automated statistics')
  assert.equal(completeHistory.min, null)
  assert.ok(completeHistory.points.every((p: any) => p.value === null && p.compatibilityValue === 65538 && p.verification === 'unverified' && !p.automaticEligible))
  historyCount = 1
  s = await turn(id, call('get_snapshot', { device_id: 3 }))
  assert(s.entries.at(-2).content.includes('超出当前会话'))
  s = await turn(id, call('write_register', { device_id: 1, address: 0, value: 5 }))
  assert(s.entries.at(-2).content.includes('工具不在允许列表'))
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  assert(s.entries.at(-2).content.includes('65538'))
  historyBatchMode = 'verified'
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  const verifiedHistory = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(verifiedHistory.count, 1); assert.equal(verifiedHistory.points[0].value, 65538)
  historySlaveId = null
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  const noSource = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(noSource.count, 0); assert.equal(noSource.points[0].compatibilityValue, 65538); assert.equal(noSource.points[0].automaticEligible, false)
  ambiguousAddress = true
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  assert.ok(s.entries.at(-2).content.includes('地址不唯一'))
  const selectionError = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(selectionError.code, 'REGISTER_AMBIGUOUS'); assert.deepEqual(selectionError.candidates.map((p: any) => [p.register_id, p.slave_id]), [[10, 1], [11, 2]])
  const selectedHistoryArgs = { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }
  historySlaveId = 2
  for (const selector of [{ slave_id: 2 }, { register_id: 11 }, { slave_id: 2, register_id: 11 }]) {
    const before = historyRequests.length
    s = await turn(id, call('query_history', { ...selectedHistoryArgs, ...selector }))
    const selected = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
    assert.equal(selected.register.id, 11); assert.equal(selected.register.slaveId, 2); assert.equal(selected.points[0].value, 131074)
    assert.ok(historyRequests.slice(before).every(source => source === 2)); assert.equal(s.sources.at(-1).registerId, 11)
  }
  const beforeInvalid = historyRequests.length, beforeSources = s.sources.length
  for (const selector of [{ slave_id: 1, register_id: 11 }, { register_id: 999 }, { slave_id: '2' }, { register_id: null }, { slave_id: 256 }]) {
    s = await turn(id, call('query_history', { ...selectedHistoryArgs, ...selector }))
    assert.ok(JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n')).error)
  }
  assert.equal(historyRequests.length, beforeInvalid); assert.equal(s.sources.length, beforeSources)
  historySlaveId = null
  s = await turn(id, call('query_history', { ...selectedHistoryArgs, slave_id: 2 }))
  const unknownSource = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(unknownSource.count, 0); assert.equal(unknownSource.points[0].value, null); assert.equal(unknownSource.points[0].slaveId, null)
  const querySchema = assistantTools.find(t => t.function.name === 'query_history')!.function.parameters
  assert.equal(querySchema.properties.slave_id.maximum, 255); assert.ok(!querySchema.required.includes('register_id'))
  ambiguousAddress = false; historySlaveId = 1
  historyBatchMode = 'mixed'
  s = await turn(id, call('query_history', { device_id: 1, area: 'holding-register', address: 0, start: '2026-10-06T00:00:00Z', end: '2026-10-06T01:00:00Z' }))
  const mixedHistory = JSON.parse(s.entries.at(-2).content.split('\n').slice(2).join('\n'))
  assert.equal(mixedHistory.count, 0); assert.equal(mixedHistory.points[0].verification, 'unknown'); assert.equal(mixedHistory.points[0].value, null)
  historyBatchMode = 'legacy'
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
  const longChainId = await session()
  responses = Array.from({ length: 8 }, () => ({ content: null, tool_calls: Array.from({ length: 20 }, (_, i) => ({ id: 'batch-' + Math.random(), type: 'function', function: { name: 'list_devices', arguments: '{}' } })) }))
  responses.push({ content: '长任务完成' })
  assert.equal((await request('POST', `/sessions/${longChainId}/messages`, { message: '查询完整数据' })).statusCode, 200)
  let longState: any
  for (let n = 0; n < 300; n++) { longState = (await request('GET', `/sessions/${longChainId}`)).json(); if (!longState.running) break; await new Promise(r => setTimeout(r, 5)) }
  assert(!longState.running && !longState.error, JSON.stringify(longState.error))
  assert.equal(longState.entries.filter((e: any) => e.role === 'tool').length, 160, 'more than 12 tools and 6 rounds complete')
  assert.equal(longState.entries.at(-1).content, '长任务完成')
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
  assert(!(await turn(attachmentId, { content: '附件已读取' }, { attachments: Array(5).fill(attachment) })).error)
  assert.equal((await request('POST', `/sessions/${attachmentId}/messages`, { message: 'test', attachments: [{ name: 'fake.png', data: attachment.data }] })).statusCode, 400)
  assert(!(await turn(attachmentId, { content: '文本已读取' }, { attachments: [{ name: 'large.txt', data: Buffer.alloc(20001, 65).toString('base64') }] })).error)
  const huge = await turn(attachmentId, { content: '完整回答：' + 'A'.repeat(1_100_000) }, { attachments: [{ name: 'huge.txt', data: Buffer.alloc(7 * 1024 * 1024, 65).toString('base64') }] })
  assert(!huge.error, huge.error)
  assert(huge.entries.at(-1).content.length > 1_000_000, 'large request bodies and model responses are not rejected')
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
  assert.equal((await request('DELETE', '/settings/minimax-cn')).statusCode, 200)
  assert.equal((await request('GET', '/settings?provider=minimax-cn')).json().hasKey, false)
  assert(!readFileSync(join(dir, 'ai-settings.json'), 'utf8').includes('native-secret'))
  assert.equal((await request('DELETE', '/settings/minimax-cn')).statusCode, 404)
  assert.equal((await request('DELETE', '/settings/custom')).statusCode, 200)
  assert.equal((await request('GET', '/settings')).json().model, '')
  assert.equal((await request('GET', '/providers')).json().configured.length, 0)
  console.log('ASSISTANT TEST OK: scope, multiword reads, tool allowlist, proposals, confirmation, conflict, replay, cancellation, settings and secret isolation')
} finally {
  await app.close()
  if (resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')) rmSync(dir, { recursive: true, force: true })
}
