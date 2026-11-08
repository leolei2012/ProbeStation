import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Context } from 'cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { verifyForwardingIdentity, createDefaultProtocolFixture } from '../packages/mcp/test/tool-registrar-contract.ts'

class FakeHttp extends EventEmitter {
  listening = false; starts = 0; stops = 0
  listen(_port: number, _host: string, callback: () => void) { this.starts++; this.listening = true; queueMicrotask(() => { this.emit('listening'); callback() }); return this }
  close(callback: () => void) { this.stops++; this.listening = false; queueMicrotask(() => { this.emit('close'); callback() }); return this }
}
const expectedCatalog: { baseline: string; names: string[]; sha256: string } = JSON.parse(readFileSync(new URL('./fixtures/mcp-tool-catalog.json', import.meta.url), 'utf8'))
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value
const source = readFileSync(new URL('../packages/mcp/src/index.ts', import.meta.url), 'utf8')
assert.equal((source.match(/^    tools\.registerTool\(/gm) ?? []).length, 42)
verifyForwardingIdentity()

const ctx = new Context(), fakeHttp = new FakeHttp(), clients: Client[] = [], servers: McpServer[] = []
let cacheReads = 0, legacyWrites = 0
try {
  await ctx.plugin(configPlugin, { dbPath: ':memory:' }); const cfg = ctx.get('config', false) as configPlugin.ConfigStore
  const d = cfg.createObject('synthetic MCP', 'mock.invalid', 502, 'master'), g1 = cfg.createGroup(d.id, 'source 1', 3, 0, 1), g2 = cfg.createGroup(d.id, 'source 2', 3, 0, 1, 'read', 2)
  const r1 = cfg.createRegister(g1.id, d.id, 'first', 3, 0, 'uint16'), r2 = cfg.createRegister(g2.id, d.id, 'second', 3, 0, 'uint16')
  const store = { getLatestByObject(_id: number, _area: string, slave: number) { cacheReads++; return { 0: { rawValue: slave * 10, quality: 'good', timestamp: '2026-11-08T00:00:00Z', slaveId: slave, batchId: 'synthetic-' + slave } } } }
  await ctx.plugin({ name: 'inert-mcp-type-services', apply(context: Context) { context.provide('store', store as any); for (const name of ['poller', 'ota', 'sink']) context.provide(name as any, {} as any) } })
  const originalCreate = http.createServer
  try { http.createServer = (() => fakeHttp) as unknown as typeof http.createServer; await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) }
  finally { http.createServer = originalCreate }
  const current = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer()
  servers.push(current)
  const connect = async (server: McpServer) => { const client = new Client({ name: 'synthetic-types', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair(); clients.push(client); await Promise.all([server.connect(b), client.connect(a)]); return client }
  const client = await connect(current), listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), expectedCatalog.names)
  assert.equal(createHash('sha256').update(JSON.stringify(canonical(listed.tools))).digest('hex'), expectedCatalog.sha256, 'all schemas, descriptions and annotations must match the reviewed baseline; intentional protocol changes require snapshot review')
  assert(listed.tools.length > 42); assert.equal(new Set(listed.tools.map(t => t.name)).size, listed.tools.length)
  const devices = await client.callTool({ name: 'list_devices', arguments: {} }); assert.equal(devices.isError, undefined)
  const base = { device_id: d.id, area: 'holding-register', address: 0 }
  const body = (result: any) => JSON.parse(result.content[0].text)
  const defaults = createDefaultProtocolFixture(); servers.push(defaults.server); const defaultClient = await connect(defaults.server)
  assert.deepEqual(body(await defaultClient.callTool({ name: 'synthetic-defaults', arguments: {} })), { limit: 7 })
  assert.deepEqual(body(await defaultClient.callTool({ name: 'synthetic-defaults', arguments: { limit: 11, name: 'synthetic' } })), { limit: 11, name: 'synthetic' })
  assert.equal((await defaultClient.callTool({ name: 'synthetic-defaults', arguments: { limit: 'invalid' } })).isError, true); assert.equal(defaults.calls(), 2)
  const ambiguous = await client.callTool({ name: 'read_register', arguments: base }); assert.equal(ambiguous.isError, true); assert.equal(cacheReads, 0)
  const selected = await client.callTool({ name: 'read_register', arguments: { ...base, slave_id: 2, register_id: r2.id } }); assert.equal(selected.isError, undefined); assert.equal(body(selected).slave_id, 2); assert.equal(body(selected).value, 20)
  const conflict = await client.callTool({ name: 'read_register', arguments: { ...base, slave_id: 2, register_id: r1.id } }); assert.equal(conflict.isError, true); assert.equal(cacheReads, 1)
  const invalid = await client.callTool({ name: 'read_register', arguments: { ...base, slave_id: '2' } }); assert.equal(invalid.isError, true); assert.equal(cacheReads, 1, 'SDK must reject malformed input before a read handler runs')
  const originalUpdate = cfg.updateObject.bind(cfg)
  cfg.updateObject = ((...args: Parameters<typeof originalUpdate>) => { legacyWrites++; throw Error('write handler must not run') })
  try { const invalidWrite = await client.callTool({ name: 'set_device_active', arguments: { device_id: d.id, active: 'yes' } }); assert.equal(invalidWrite.isError, true); assert.equal(legacyWrites, 0) }
  finally { cfg.updateObject = originalUpdate }
  assert.equal(fakeHttp.starts, 1); console.log('MCP TYPES OK: ' + listed.tools.length + ' actual SDK tool definitions match baseline; memory protocol validates source selection and rejects invalid input before reads/writes; six compile-only negative assertions, no real sockets/devices/models')
} finally {
  for (const client of clients) await client.close()
  for (const server of servers) await server.close()
  await ctx.fiber.dispose(); assert.equal(fakeHttp.stops, 1)
}
