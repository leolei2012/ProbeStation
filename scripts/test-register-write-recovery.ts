import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { registerWriteSource, registerWriteSourceMatches, type GuardedWritePlan } from '../packages/core/src/guarded-register-write.ts'
import { executeBoundWrite, type BoundWire } from '../packages/modbus/src/bound-write.ts'
import { registerWidth } from '../packages/core/src/codec.ts'
import { pendingWritesRequest, writeRequest } from '../apps/web/src/register-write-client.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

// Actual UI request helper, Fastify, SQLite and MCP SDK. Every wire is injected; no real sockets/devices.
const ctx = new Context(), app = Fastify(), frames: Buffer[] = [], peers: Array<{ client: Client; sdk: McpServer }> = []
const runningIds = new Set<string>()
let echo = true
const wire = (_plan: GuardedWritePlan): BoundWire => {
  const events = new EventEmitter(); let ready = false
  return { events, async open() { ready = true }, ready: () => ready, async close() { ready = false }, write(frame) {
    frames.push(Buffer.from(frame))
    if (echo) setImmediate(() => { const reply = Buffer.from(frame.subarray(0, 12)); reply.writeUInt16BE(6, 4); events.emit('data', reply) })
  } }
}
const sender = { canWriteBoundRegisters: () => true, write: async () => { assert.fail('legacy writer must never run') },
  isBoundRegisterWriteRunning: (id: string) => runningIds.has(id),
  writeBoundRegisters(plan: GuardedWritePlan, accept: (send: () => void) => void) { return executeBoundWrite(plan, accept, () => true, wire) } }
class InertHttp extends EventEmitter { listening = false; listen(_port: number, _host: string, callback: () => void) { this.listening = true; queueMicrotask(() => { this.emit('listening'); callback() }); return this }; close(callback: () => void) { this.listening = false; queueMicrotask(() => { this.emit('close'); callback() }); return this } }
const storage = new Map<string, string>(), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
try {
  await ctx.plugin(configPlugin, { dbPath: ':memory:' }); const cfg = ctx.get('config', false) as configPlugin.ConfigStore
  const d = cfg.createObject('synthetic write recovery', '192.0.2.91', 502)
  cfg.createGroup(d.id, 'unused', 3, 0, 1)
  const g = cfg.createGroup(d.id, 'holding', 3, 0x1000, 8, 'read', 7)
  assert.notEqual(g.id, d.id, 'fixture must catch device-id/group-id confusion')
  const r = cfg.createRegister(g.id, d.id, 'Switch', 3, 0x1000, 'uint16')
  const wide = cfg.createRegister(g.id, d.id, 'wide', 3, 0x1002, 'uint32-LE')
  const covered = cfg.createRegister(g.id, d.id, 'covered', 3, 0x1003, 'uint16')
  const source = () => registerWriteSource(cfg.getObject(d.id), cfg.getGroup(g.id), cfg.getRegister(r.id))
  const reorder = (value: any): any => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value
  registerRegisterWrite(app, cfg, sender)
  const fetcher: typeof fetch = async (url, init) => {
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: String(url), headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined })
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } })
  }
  const request = (path: string, body?: unknown) => writeRequest(path, body, 1000, fetcher)
  const prepare = (value: string, method = 'single', expected = source()) => request(`/api/registers/${r.id}/write/prepare`, { version: 1, value, method, source: expected })
  const execute = (id: string) => request(`/api/register-writes/${id}/execute`, { version: 1 })
  const reordered = await prepare('1', 'single', reorder(source()))
  assert.equal((await execute(reordered.id)).state, 'acknowledged'); assert.equal(frames.at(-1)![7], 6)
  const multiple = await prepare('0', 'multiple'); assert.equal((await execute(multiple.id)).state, 'acknowledged')
  assert.equal(frames.at(-1)![7], 16); assert.equal(frames.at(-1)!.readUInt16BE(10), 1); assert.equal(frames.at(-1)!.readUInt16BE(13), 0)
  await assert.rejects(prepare('1', 'single', { ...source(), group: { ...source().group, slaveId: 9 } }), /页面与后台.*不一致/)
  await assert.rejects(prepare('1', 'single', { ...source(), register: { ...source().register, alias: undefined } }), /页面与后台/)
  assert.throws(() => cfg.prepareRegisterWrite(covered.id, 1, registerWriteSource(cfg.getObject(d.id), g, covered)), /覆盖/)
  assert.throws(() => cfg.prepareRegisterWrite(wide.id, '65538', registerWriteSource(cfg.getObject(d.id), g, wide), 'single'), /FC16/)

  const old = await prepare('1'); cfg.updateGroup(g.id, { name: 'changed' })
  const storageKey = 'ps-register-write:' + JSON.stringify([d.id, 'tcp', d.ip, d.port, d.serialPath, g.id, r.id])
  storage.set(storageKey, old.id)
  const driver = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { registerWidth, registerWriteSourceMatches, writeRequest: request, pendingWritesRequest: (source: any) => pendingWritesRequest(source, fetcher) }, { source: reorder(source()), currentValue: '0', english: false, onClose() {} })
  const settle = async () => { for (let i = 0; i < 15; i++) { await new Promise(resolve => setImmediate(resolve)); driver.render() } }
  try {
    const before = frames.length; await settle()
    assert.equal(cfg.getRegisterWrite(old.id).state, 'not-sent'); assert.equal(frames.length, before)
    assert.equal(driver.one('input', p => p.type !== 'checkbox').props.disabled, false, 'retired receipt must not trap the input')
    driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '1' } }); driver.render()
    driver.one('select').props.onChange({ target: { value: 'multiple' } }); driver.render()
    driver.one('button', p => p.children === '写入').props.onClick(); await settle()
    assert.equal(frames.length, before + 1, 'reopen after stale plan can create and send a fresh command'); assert.equal(frames.at(-1)![7], 16)
  } finally { driver.dispose() }
  const expiring = await prepare('1'), now = Date.now
  try { Date.now = () => expiring.plan.expiresAt + 1; const retired = cfg.getRegisterWrite(expiring.id); assert.equal(retired.state, 'not-sent'); assert.match(retired.message, /过期/) } finally { Date.now = now }
  assert.equal((await execute(expiring.id)).state, 'not-sent')

  await ctx.plugin({ name: 'inert-bound-mcp-services', apply(context: Context) { context.provide('poller', sender as any); for (const name of ['store', 'ota', 'sink']) context.provide(name as any, {} as any) } })
  const create = http.createServer
  try { http.createServer = (() => new InertHttp()) as unknown as typeof create; await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
  const open = async () => { const sdk = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer(), client = new Client({ name: 'synthetic write', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair(); peers.push({ sdk, client }); await Promise.all([sdk.connect(b), client.connect(a)]); return client }
  const client = await open(), body = (result: any) => JSON.parse(result.content[0].text)
  const args = { device_id: d.id, address: 0x1000, value: 1, slave_id: 7, register_id: r.id, value_mode: 'raw', method: 'single', request_id: randomUUID() }
  let before = frames.length
  const sent = await client.callTool({ name: 'write_register', arguments: args })
  assert.equal(sent.isError, undefined, JSON.stringify(sent)); assert.equal(body(sent).state, 'acknowledged'); assert.equal(frames.length, before + 1); assert.equal(frames.at(-1)![7], 6)
  const secondClient = await open(), replay = await secondClient.callTool({ name: 'write_register', arguments: { ...args, request_id: args.request_id.toUpperCase(), value: 0 } })
  assert.equal(body(replay).request_reused, true); assert.equal(frames.length, before + 1)
  assert.equal(body(await secondClient.callTool({ name: 'get_register_write_result', arguments: { operation_id: args.request_id.toUpperCase() } })).state, 'acknowledged')
  const other = cfg.createGroup(d.id, 'other slave', 3, 0x1000, 1, 'read', 8); cfg.createRegister(other.id, d.id, 'duplicate address', 3, 0x1000, 'uint16')
  before = frames.length
  const ambiguous = await client.callTool({ name: 'write_register', arguments: { device_id: d.id, address: 0x1000, value: 1 } })
  assert.equal(ambiguous.isError, true); assert.equal(body(ambiguous).code, 'REGISTER_AMBIGUOUS'); assert.equal(frames.length, before)
  cfg.updateRegister(r.id, { factor: 0.1 })
  const physical = await client.callTool({ name: 'write_register', arguments: { ...args, request_id: randomUUID(), value: 58.3, value_mode: 'physical', method: 'multiple' } })
  assert.equal(body(physical).state, 'acknowledged', JSON.stringify(physical)); assert.deepEqual(body(physical).plan.words, [583]); assert.equal(frames.at(-1)![7], 16)
  const raw = await client.callTool({ name: 'write_register', arguments: { ...args, request_id: randomUUID(), value: 583 } }); assert.deepEqual(body(raw).plan.words, [583])
  cfg.updateObject(d.id, { timeoutMs: 100 }); echo = false
  const queuedSource = registerWriteSource(cfg.getObject(d.id), cfg.getGroup(g.id), cfg.getRegister(wide.id))
  const beforeReview = cfg.prepareRegisterWrite(wide.id, '65538', queuedSource, 'multiple')
  const overtaken = cfg.prepareRegisterWrite(wide.id, '65538', queuedSource, 'multiple')
  const unknownArgs = { ...args, request_id: randomUUID() }, unknown = await client.callTool({ name: 'write_register', arguments: unknownArgs })
  assert.equal(unknown.isError, true); assert.equal(body(unknown).state, 'unknown'); before = frames.length
  assert.equal(cfg.claimRegisterWrite(overtaken.id).operation.state, 'not-sent', 'an overtaken prepared request fails definitively before sending')
  assert.equal(body(await secondClient.callTool({ name: 'write_register', arguments: unknownArgs })).state, 'unknown'); assert.equal(frames.length, before)
  assert.equal(body(await client.callTool({ name: 'get_register_write_result', arguments: { operation_id: unknownArgs.request_id } })).state, 'unknown')
  const discovered = body(await secondClient.callTool({ name: 'list_pending_register_writes', arguments: { device_id: d.id } }))
  assert.equal(discovered.operations[0].id, unknownArgs.request_id)
  const blocked = await secondClient.callTool({ name: 'write_register', arguments: { ...args, request_id: randomUUID() } })
  assert.equal(body(blocked).code, 'REGISTER_WRITE_BLOCKED'); assert.equal(body(blocked).pending.operations[0].id, unknownArgs.request_id)
  assert.equal(frames.length, before)
  const reviewArgs = { device_id: d.id, operation_id: unknownArgs.request_id, confirmed_on_site: true }
  assert.equal((await client.callTool({ name: 'review_register_write_result', arguments: { ...reviewArgs, confirmed_on_site: false } })).isError, true)
  runningIds.add(unknownArgs.request_id)
  assert.equal((await client.callTool({ name: 'review_register_write_result', arguments: reviewArgs })).isError, true)
  await assert.rejects(request(`/api/register-writes/${unknownArgs.request_id}/review-unknown`, { confirmedOnSite: true }), /仍在执行/)
  runningIds.delete(unknownArgs.request_id)
  storage.clear(); echo = true
  const recovery = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { registerWidth, registerWriteSourceMatches, writeRequest: request, pendingWritesRequest: (source: any) => pendingWritesRequest(source, fetcher) },
    { source: registerWriteSource(cfg.getObject(d.id), cfg.getGroup(g.id), cfg.getRegister(wide.id)), currentValue: '0', english: false, onClose() {} })
  const flush = async () => { for (let i = 0; i < 15; i++) { await new Promise(resolve => setImmediate(resolve)); recovery.render() } }
  try {
    await flush()
    recovery.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '65538' } }); recovery.render()
    assert.equal(recovery.one('button', p => p.children === '写入').props.disabled, true)
    assert.equal(recovery.one('button', p => p.children === '已核实，解除阻塞').props.disabled, true)
    recovery.one('input', p => p.type === 'checkbox').props.onChange({ target: { checked: true } }); recovery.render()
    recovery.one('button', p => p.children === '已核实，解除阻塞').props.onClick(); await flush()
    assert.equal(frames.length, before, 'review cannot send/replay a command')
    assert.equal(cfg.getRegisterWrite(unknownArgs.request_id).state, 'reviewed-unknown')
    assert.equal(cfg.getRegisterWrite(beforeReview.id).state, 'not-sent')
    assert.equal(cfg.claimRegisterWrite(beforeReview.id).claimed, false, 'a delayed execute from an older dialog cannot send after unblocking')
    assert.equal(recovery.one('input', p => p.type !== 'checkbox').props.value, '65538', 'recovery preserves the new point/value draft')
    assert.equal(recovery.one('button', p => p.children === '写入').props.disabled, false)
    recovery.one('button', p => p.children === '写入').props.onClick(); await flush()
    assert.equal(frames.length, before + 1, 'the separate explicit Write sends exactly one fresh operation')
  } finally { recovery.dispose() }
  echo = false
  const againArgs = { ...args, request_id: randomUUID() }
  await client.callTool({ name: 'write_register', arguments: againArgs }); before = frames.length
  assert.equal(body(await secondClient.callTool({ name: 'review_register_write_result', arguments: { ...reviewArgs, operation_id: againArgs.request_id } })).state, 'reviewed-unknown')
  assert.equal(body(await client.callTool({ name: 'list_pending_register_writes', arguments: { device_id: d.id } })).operations.length, 0)
  assert.equal(frames.length, before, 'MCP review never sends or replays')
  console.log('WRITE RECOVERY OK: FC06/FC16, sources, expiry, actual MCP dispatch/receipt replay, pending discovery across points/clients, explicit review without replay, active-send protection, preserved draft, old prepared cancellation and fresh explicit send; injected wire only')
} finally {
  for (const { client, sdk } of peers) { await client.close(); await sdk.close() }
  await app.close(); await ctx.fiber.dispose()
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else delete (globalThis as any).sessionStorage
}
