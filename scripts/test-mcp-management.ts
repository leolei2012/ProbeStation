import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { registerAssistant } from '../packages/api/src/assistant.ts'
import { boot } from './_bootstrap.ts'

const { ctx, dir } = await boot()
const cfg: any = ctx.get('config', false), store: any = ctx.get('store', false), poller: any = ctx.get('poller', false)
store.setRetentionSeconds(0)
const app = Fastify(), sent: any[] = []
let providerError = false
registerAssistant(app, { cfg, store, poller }, dir, async (_url, options) => {
  sent.push({ body: JSON.parse(String(options?.body)), headers: options?.headers })
  return providerError ? new Response('SECRET PROVIDER DETAIL', { status: 401 }) : new Response(JSON.stringify({ choices: [{ message: { content: '温度偏高，请检查散热。' } }] }))
})
ctx.provide('api', app)
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 })
const server = (ctx.get('mcp', false) as any).createServer()
const [local, remote] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'management-test', version: '1' })
await server.connect(remote); await client.connect(local)
async function call(name: string, args: any) {
  const result: any = await client.callTool({ name, arguments: args })
  assert(!result.isError, JSON.stringify(result))
  return JSON.parse(result.content[0].text)
}
async function fails(name: string, args: any) {
  const result: any = await client.callTool({ name, arguments: args })
  assert(result.isError, JSON.stringify(result))
  return JSON.stringify(result)
}
try {
  const d = await call('create_device', { name: 'Managed', ip: '127.0.0.1', port: 19501 })
  const other = await call('create_device', { name: 'Other', ip: '127.0.0.1', port: 19502 })
  const g = await call('create_group', { device_id: d.id, name: 'Values', start_address: 0, quantity: 1 })
  const reg = cfg.listRegisters(g.id)[0]
  const rule = await call('create_alarm_rule', { register_id: reg.id, operator: '>=', threshold: 100, message: '高温' })
  const updated = await call('update_alarm_rule', { rule_id: rule.id, threshold: 200, message: null })
  assert.equal(updated.operator, '>='); assert.equal(updated.threshold, 200); assert.equal(updated.message, null)
  await fails('create_alarm_rule', { register_id: 99999, operator: '>=', threshold: 100 })
  await fails('update_alarm_rule', { rule_id: 99999, threshold: 0 })
  await call('delete_alarm_rule', { rule_id: rule.id })
  assert.equal((await call('list_alarm_rules', { device_id: d.id })).length, 0)
  await call('create_alarm_rule', { register_id: reg.id, operator: '<', threshold: 0 })

  const base = Date.now() - 60000, start = new Date(base).toISOString(), end = new Date(base + 2000).toISOString()
  store.write([0, 1000, 3000].map(delta => ({ objectId: d.id, area: 'holding-register', address: 0, timestamp: new Date(base + delta).toISOString(), rawValue: delta, quality: 'good' })))
  store.write([{ objectId: other.id, area: 'holding-register', address: 0, timestamp: start, rawValue: 99, quality: 'good' }])
  const pendingFlush = store.flush()
  const preview = await call('delete_history', { device_id: d.id, start, end })
  await pendingFlush
  assert.equal(preview.dry_run, true); assert.equal(preview.affected_rows, 2)
  const csv = await call('export_history', { device_id: d.id, start, end, register_ids: [reg.id], tz_offset_min: 480 })
  assert(Buffer.from(csv.b64, 'base64').toString('utf8').includes('1000'))
  const xlsx = await call('export_history', { device_id: d.id, start, end, format: 'xlsx' })
  assert.equal(Buffer.from(xlsx.b64, 'base64').subarray(0, 2).toString(), 'PK')
  await fails('delete_history', { device_id: d.id, start: 'invalid', end, dry_run: false })
  await fails('export_history', { device_id: d.id, start, end, register_ids: [99999] })
  assert.equal((await call('delete_history', { device_id: d.id, start, end, dry_run: false })).affected_rows, 2)
  assert.equal((await store.statsByObject(d.id)).totalRows, 1)
  assert.equal((await store.statsByObject(other.id)).totalRows, 1)
  assert.equal(store.getLatestByObjectAll(d.id)['holding-register:0'].rawValue, 3000)

  await fails('ask_ai', { question: '分析温度' })
  const configured = await app.inject({ method: 'POST', url: '/api/ai/settings', headers: { 'x-probestation-ai': '1' }, payload: { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'fake-secret', reasoningProtocol: 'reasoning_effort' } })
  assert.equal(configured.statusCode, 200, configured.body)
  const answer = await call('ask_ai', { question: '分析温度', context: '这是试验数据', device_id: d.id, effort: 'high' })
  assert.equal(answer.model, 'test-model'); assert.equal(answer.answer, '温度偏高，请检查散热。')
  assert(!JSON.stringify(answer).includes('fake-secret'))
  assert.equal(sent[0].body.reasoning_effort, 'high'); assert(!sent[0].body.tools)
  assert(sent[0].body.messages.some((m: any) => m.content.includes('Managed')))
  const callsBefore = sent.length
  await fails('ask_ai', { question: '分析温度', device_id: 99999 })
  assert.equal(sent.length, callsBefore)
  providerError = true
  const failure = await fails('ask_ai', { question: '测试失败' })
  assert(!failure.includes('SECRET PROVIDER DETAIL')); assert(!failure.includes('fake-secret'))

  await call('delete_device', { device_id: d.id })
  assert(!cfg.getObject(d.id)); assert(!cfg.getGroup(g.id)); assert.equal(cfg.listRules().length, 0)
  assert.equal((await store.statsByObject(d.id)).totalRows, 1, 'device deletion retains history')
  assert.equal((await call('delete_history', { device_id: d.id, start, end: new Date(base + 4000).toISOString(), dry_run: false })).affected_rows, 1)
  assert(cfg.getObject(other.id))
  console.log('MCP MANAGEMENT OK: device/alarm CRUD, history preview/delete/export, isolation, buffered writes and configured AI consultation')
} finally { await client.close(); await server.close(); await app.close() }
process.exit(0)
