import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConfigStore } from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

const body = (result: any) => JSON.parse(result.content[0].text)
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); return this }
  close(done: () => void) { this.closes++; this.listening = false; queueMicrotask(done); return this }
}
const tools = ['create_device','delete_device','set_device_active','set_poll_interval','set_group_active','delete_history','create_group','create_register','delete_register','delete_group','retention_global','retention_device']
const red = process.argv[2] === 'red', stages = red ? ['log-before'] : ['normal','log-before','log-after','exporter']
const cases = tools.flatMap(tool => stages.map(stage => ({ tool, stage }))).concat(['create_device','delete_device','set_device_active'].map(tool => ({ tool, stage: 'sync' })), [{ tool: 'create_device', stage: 'notify' }, { tool: 'create_register', stage: 'primary' }])
const failures: string[] = [], unhandled: unknown[] = [], denied: string[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch, block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name) }
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', onUnhandled)
try {
  for (const { tool, stage } of cases) {
    const ctx = new Context(), server = new FakeHttp(), warnings: string[] = [], failure = Error('synthetic private ' + stage)
    let armed = false, logCalls = 0, syncCalls = 0, historyCalls = 0, retentionCalls = 0, retention = 0
    const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (armed && stage === 'notify') throw failure })
    let client: Client | undefined, sdk: McpServer | undefined
    const create = http.createServer
    try {
      ctx.logger.exporter({ export(message) { if (message.name === 'mcp' && message.type === 'warn') { warnings.push(message.args.join(' ')); if (stage === 'exporter') throw failure } } })
      const device = cfg.createObject('synthetic base', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'base', 3, 0, 4), register = cfg.createRegister(group.id, device.id, 'base', 3, 0, 'uint16')
      const store = { async deleteHistory(_id: number, _start: string, _end: string, dryRun: boolean) { historyCalls++; return { dryRun, affectedRows: 5 } }, setRetentionSeconds(value: number) { retentionCalls++; retention = value } }
      const slaves = { async sync() { syncCalls++; if (stage === 'sync') throw failure } }
      await ctx.plugin({ name: 'inert-mcp-auxiliary-services', apply(context: Context) { context.provide('config', cfg as any); context.provide('store', store as any); context.provide('deviceSlaves', slaves as any); for (const service of ['poller','ota','sink']) context.provide(service as any, {} as any) } })
      http.createServer = (() => server) as unknown as typeof create
      try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
      sdk = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer(); client = new Client({ name: 'synthetic auxiliary', version: '1' })
      const [local, remote] = InMemoryTransport.createLinkedPair(); await Promise.all([sdk.connect(remote), client.connect(local)])
      let name = tool, args: Record<string, unknown> = {}, expected: () => unknown = () => ({})
      switch (tool) {
        case 'create_device': args = { name: 'synthetic new', ip: 'new.mock.invalid' }; expected = () => { const row = cfg.listObjects().find(row => row.name === 'synthetic new'); assert(row); assert.equal(cfg.listObjects().length, 2); return row }; break
        case 'delete_device': args = { device_id: device.id }; expected = () => { assert.equal(cfg.getObject(device.id), undefined); return { ok: true, device_id: device.id, history_preserved: true } }; break
        case 'set_device_active': args = { device_id: device.id, active: false }; expected = () => { assert.equal(cfg.getObject(device.id)?.isActive, 0); return cfg.getObject(device.id) }; break
        case 'set_poll_interval': args = { device_id: device.id, poll_interval_ms: 123 }; expected = () => { assert.equal(cfg.getObject(device.id)?.pollIntervalMs, 123); return { ok: true, device_id: device.id, poll_interval_ms: 123 } }; break
        case 'set_group_active': args = { group_id: group.id, active: false }; expected = () => { assert.equal(cfg.getGroup(group.id)?.isActive, 0); return cfg.getGroup(group.id) }; break
        case 'delete_history': args = { device_id: device.id, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', dry_run: false }; expected = () => { assert.equal(historyCalls, 1); return { device_id: device.id, start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', dry_run: false, affected_rows: 5 } }; break
        case 'create_group': args = { device_id: device.id, name: 'synthetic new', start_address: 10, quantity: 2 }; expected = () => { const row = cfg.listGroups(device.id).find(row => row.name === 'synthetic new'); assert(row); assert.equal(cfg.listRegisters(row.id).length, 2); return row }; break
        case 'create_register': args = { group_id: group.id, alias: 'synthetic new', start_address: 2, data_type: 'uint16' }; expected = () => { const row = cfg.listRegisters(group.id).find(row => row.alias === 'synthetic new'); assert(row); assert.equal(cfg.listRegisters(group.id).length, 2); return row }; break
        case 'delete_register': args = { register_id: register.id }; expected = () => { assert.equal(cfg.getRegister(register.id), undefined); return { ok: true, register_id: register.id } }; break
        case 'delete_group': args = { group_id: group.id }; expected = () => { assert.equal(cfg.getGroup(group.id), undefined); assert.equal(cfg.getRegister(register.id), undefined); return { ok: true, group_id: group.id } }; break
        case 'retention_global': name = 'set_data_retention'; args = { retention_seconds: 123 }; expected = () => { assert.equal(retention, 123); assert.equal(retentionCalls, 1); return { ok: true } }; break
        case 'retention_device': name = 'set_data_retention'; args = { device_id: device.id, retention_seconds: 123 }; expected = () => { assert.equal(cfg.getObject(device.id)?.dataRetainSeconds, 123); return { ok: true } }; break
      }
      const originalLog = cfg.log.bind(cfg)
      cfg.log = (...input: Parameters<typeof originalLog>) => { logCalls++; if (stage === 'log-before' || stage === 'exporter') throw failure; originalLog(...input); if (stage === 'log-after') throw failure }
      if (stage === 'primary') cfg.createRegister = () => { throw failure }
      armed = true
      const result = await client.callTool({ name, arguments: args })
      if (stage === 'primary') {
        assert.equal(result.isError, true); assert.equal(cfg.listRegisters(group.id).length, 1); assert.equal(logCalls, 0); assert.equal(warnings.length, 0)
      } else {
        const applied = expected()
        if (stage === 'notify') {
          assert.equal(result.isError, true); assert.equal(syncCalls, 0); assert.equal(logCalls, 0)
          console.log('MCP AUX KNOWN LIMIT: createObject notification throws after INSERT; configuration exists despite isError, no blanket suppression')
        } else if (stage === 'sync') {
          assert.equal(result.isError, true); assert.equal(syncCalls, 1); assert.equal(logCalls, 0)
          assert(Array.isArray(result.content)); const message = String(result.content[0]?.text)
          assert(message.includes('配置操作已提交') && message.includes('同步未完成'), 'runtime failure must distinguish committed configuration from incomplete synchronization')
        } else {
          assert.equal(result.isError, undefined, 'post-operation logging must not misreport a completed ' + tool)
          assert.deepEqual(body(result), JSON.parse(JSON.stringify(applied)), 'success JSON retains the original shape')
          assert.equal(logCalls, 1); assert.equal(cfg.listLogs().length, stage === 'normal' || stage === 'log-after' ? 1 : 0)
          assert.equal(warnings.length, stage === 'normal' ? 0 : 1); assert(warnings.every(message => message.includes('日志') && !message.includes('private')))
        }
      }
      console.log('MCP AUX OK: ' + tool + '/' + stage)
    } catch (error) { failures.push(tool + '/' + stage + ': ' + (error instanceof Error ? error.message : String(error))); console.log('MCP AUX REPRO: ' + failures.at(-1)) }
    finally { http.createServer = create; await client?.close(); await sdk?.close(); await ctx.fiber.dispose(); await cfg.close().catch(() => {}); assert.equal(server.closes, 1) }
  }
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, []); assert.deepEqual(failures, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', onUnhandled) }
console.log('MCP AUXILIARY TEST OK: ' + cases.length + ' actual SDK/memory configuration cases, mock history/retention/runtime services; primary/notification uncertainty remains explicit, no real sockets, devices/data or model')
