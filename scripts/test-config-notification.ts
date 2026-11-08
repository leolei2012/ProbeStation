import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { Context } from 'cordis'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConfigStore } from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

const committed = (error: unknown) => error instanceof Error && error.message.includes('配置数据库操作已提交') && error.message.includes('通知未完成')
const capture = (action: () => unknown) => { try { action(); return undefined } catch (error) { return error } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); return this }
  close(done: () => void) { this.listening = false; this.closes++; queueMicrotask(done); return this }
}
const cases: string[] = [], failures: string[] = [], unhandled: unknown[] = [], denied: string[] = []
const run = async (name: string, action: () => void | Promise<void>) => { try { await action(); cases.push(name); console.log('CONFIG NOTIFY OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('CONFIG NOTIFY REPRO: ' + failures.at(-1)) } }
const onUnhandled = (error: unknown) => { unhandled.push(error) }, listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name) }
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', onUnhandled)
function fixture(withProtocolMetadata = true) {
  let armed = false, notifications = 0
  const failure = Object.assign(Error('synthetic private observer failure'), withProtocolMetadata ? { statusCode: 409, code: 'SYNTHETIC_NOTIFY' } : {})
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (armed) { notifications++; throw failure } })
  const d = cfg.createObject('synthetic base', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'base', 3, 0, 1), r = cfg.createRegister(g.id, d.id, 'base', 3, 0, 'uint16'), rule = cfg.createRule(r.id, '>', 1, 'base')
  // Test-only adapter for native transaction/SQL fault injection; no real database is opened.
  const db = (cfg as unknown as { db: DatabaseSync }).db
  const graph = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listGroups(d.id), points: cfg.listRegistersByObject(d.id), rules: cfg.listRules() })
  return { cfg, db, d, g, r, rule, failure, graph, arm: () => { armed = true }, notifications: () => notifications }
}
const mutations = ['createObject','updateObject','toggleObject','deleteObject','createGroup','updateGroup','toggleGroup','deleteGroup','createRegister','updateRegister','deleteRegister','createRule','updateRule','deleteRule']
try {
  for (const method of mutations) await run(method, async () => {
    const f = fixture(), { cfg, d, g, r, rule, db } = f
    try {
      let action: () => unknown, applied: () => void
      switch (method) {
        case 'createObject': action = () => cfg.createObject('new', 'new.mock.invalid', 502); applied = () => assert.equal(cfg.listObjects().length, 2); break
        case 'updateObject': action = () => cfg.updateObject(d.id, { name: 'after' }); applied = () => assert.equal(cfg.getObject(d.id)?.name, 'after'); break
        case 'toggleObject': action = () => cfg.toggleObject(d.id); applied = () => assert.equal(cfg.getObject(d.id)?.isActive, 0); break
        case 'deleteObject': action = () => cfg.deleteObject(d.id); applied = () => { assert.equal(cfg.getObject(d.id), undefined); assert.equal(cfg.listRules().length, 0) }; break
        case 'createGroup': action = () => cfg.createGroup(d.id, 'new', 3, 10, 1); applied = () => assert.equal(cfg.listGroups(d.id).length, 2); break
        case 'updateGroup': action = () => cfg.updateGroup(g.id, { quantity: 3 }); applied = () => { assert.equal(cfg.getGroup(g.id)?.quantity, 3); assert.equal(cfg.listRegisters(g.id).length, 3) }; break
        case 'toggleGroup': action = () => cfg.toggleGroup(g.id); applied = () => assert.equal(cfg.getGroup(g.id)?.isActive, 0); break
        case 'deleteGroup': action = () => cfg.deleteGroup(g.id); applied = () => { assert.equal(cfg.getGroup(g.id), undefined); assert.equal(cfg.listRules().length, 0) }; break
        case 'createRegister': action = () => cfg.createRegister(g.id, d.id, 'new', 3, 0, 'uint16'); applied = () => assert.equal(cfg.listRegisters(g.id).length, 2); break
        case 'updateRegister': action = () => cfg.updateRegister(r.id, { alias: 'after' }); applied = () => assert.equal(cfg.getRegister(r.id)?.alias, 'after'); break
        case 'deleteRegister': action = () => cfg.deleteRegister(r.id); applied = () => { assert.equal(cfg.getRegister(r.id), undefined); assert.equal(cfg.listRules().length, 0) }; break
        case 'createRule': action = () => cfg.createRule(r.id, '<', 2, 'new'); applied = () => assert.equal(cfg.listRules().length, 2); break
        case 'updateRule': action = () => cfg.updateRule(rule.id, { registerId: r.id, operator: '<', threshold: 2, message: 'after' }); applied = () => assert.equal(cfg.listRules()[0].message, 'after'); break
        default: action = () => cfg.deleteRule(rule.id); applied = () => assert.equal(cfg.listRules().length, 0)
      }
      f.arm(); const error = capture(action); applied(); assert.equal(db.isTransaction, false); assert.equal(f.notifications(), 1)
      assert(committed(error), 'committed SQL followed by observer failure needs explicit committed context: ' + method)
      assert.equal((error as Error).cause, f.failure); assert.equal((error as { statusCode?: number }).statusCode, 409); assert.equal((error as { code?: string }).code, 'SYNTHETIC_NOTIFY')
      assert(!(error as Error).message.includes('private'))
    } finally { await cfg.close() }
  })
  for (const mode of ['outer-transaction','sql-failure','validation-failure','transaction-rollback','commit-failure','commit-ack-unknown','delete-step-rollback','protected-warning'] as const) await run(mode, async () => {
    const f = fixture(), { cfg, db } = f, exec = db.exec.bind(db), before = f.graph()
    try {
      f.arm()
      if (mode === 'outer-transaction') { exec('BEGIN'); const error = capture(() => cfg.createObject('outer', 'mock.invalid', 502)); assert.equal(error, f.failure); assert.equal(committed(error), false); exec('ROLLBACK'); assert.equal(f.graph(), before) }
      if (mode === 'sql-failure') { exec("CREATE TRIGGER synthetic_insert BEFORE INSERT ON monitor_objects BEGIN SELECT RAISE(ABORT, 'synthetic INSERT blocked'); END"); const error = capture(() => cfg.createObject('blocked', 'mock.invalid', 502)); assert(error); assert.equal(committed(error), false); assert.equal(f.notifications(), 0); assert.equal(f.graph(), before) }
      if (mode === 'validation-failure') { const error = capture(() => cfg.createObject('invalid', 'not-an-ip', 0, 'slave')); assert.equal((error as { statusCode?: number }).statusCode, 400); assert.equal(committed(error), false); assert.equal(f.notifications(), 0); assert.equal(f.graph(), before) }
      if (mode === 'transaction-rollback') { exec("CREATE TRIGGER synthetic_point BEFORE INSERT ON registers WHEN NEW.start_address = 2 BEGIN SELECT RAISE(ABORT, 'synthetic point blocked'); END"); const error = capture(() => cfg.updateGroup(f.g.id, { quantity: 3 })); assert(error); assert.equal(committed(error), false); assert.equal(f.graph(), before); assert.equal(f.notifications(), 0) }
      if (mode === 'commit-failure' || mode === 'commit-ack-unknown') {
        db.exec = sql => { if (sql === 'COMMIT') { if (mode === 'commit-ack-unknown') exec(sql); throw Error('synthetic COMMIT acknowledgement failure') }; return exec(sql) }
        const error = capture(() => cfg.updateGroup(f.g.id, { quantity: 2 })); assert(error); assert.equal(committed(error), false); assert.equal(f.notifications(), 0)
        if (mode === 'commit-failure') assert.equal(f.graph(), before)
        else { assert.notEqual(f.graph(), before); assert(error instanceof AggregateError); console.log('CONFIG NOTIFY KNOWN LIMIT: commit acknowledgement can fail after native COMMIT; not inferred as no effect or classified by readback') }
      }
      if (mode === 'delete-step-rollback') { exec("CREATE TRIGGER synthetic_delete BEFORE DELETE ON registers BEGIN SELECT RAISE(ABORT, 'synthetic register delete blocked'); END"); const error = capture(() => cfg.deleteObject(f.d.id)); assert(error); assert.equal(committed(error), false); assert.equal(f.notifications(), 0); assert.equal(f.graph(), before); assert.equal(db.isTransaction, false) }
      if (mode === 'protected-warning') { const snapshot = cfg.getGroupSettings(f.g.id); const result = cfg.updateGroupSettings(f.g.id, { expectedRevision: snapshot.revision, changes: { name: 'after' } }); assert.equal(result.snapshot.group.name, 'after'); assert.equal(result.warnings.length, 1); assert(result.warnings[0].includes('已保存')); assert.equal(f.notifications(), 1) }
    } finally { db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); await cfg.close() }
  })
  for (const tool of ['create_device','set_group_active','create_register','create_alarm_rule','update_alarm_rule','delete_alarm_rule']) await run('MCP/' + tool, async () => {
    const f = fixture(false), ctx = new Context(), httpServer = new FakeHttp(), create = http.createServer
    let sdk: McpServer | undefined, client: Client | undefined, syncs = 0
    try {
      await ctx.plugin({ name: 'inert-config-notification-services', apply(context: Context) { context.provide('config', f.cfg as any); context.provide('deviceSlaves', { async sync() { syncs++ } } as any); for (const name of ['store','poller','ota','sink']) context.provide(name as any, {} as any) } })
      http.createServer = (() => httpServer) as unknown as typeof create; try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
      sdk = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer(); client = new Client({ name: 'synthetic notification', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair(); await Promise.all([sdk.connect(b),client.connect(a)])
      const inputs: Record<string, Record<string, unknown>> = { create_device: { name: 'new', ip: 'new.mock.invalid' }, set_group_active: { group_id: f.g.id, active: false }, create_register: { group_id: f.g.id, start_address: 0 }, create_alarm_rule: { register_id: f.r.id, operator: '<', threshold: 2 }, update_alarm_rule: { rule_id: f.rule.id, threshold: 3 }, delete_alarm_rule: { rule_id: f.rule.id } }
      f.arm(); const result = await client.callTool({ name: tool, arguments: inputs[tool] }); assert.equal(result.isError, true); assert(Array.isArray(result.content)); assert(committed(new Error(String(result.content[0]?.text))), 'MCP must preserve the committed notification context, including legacy alarm handler')
      assert.equal(f.notifications(), 1); assert.equal(syncs, 0)
      if (tool === 'create_device') assert.equal(f.cfg.listObjects().length, 2)
      if (tool === 'set_group_active') assert.equal(f.cfg.getGroup(f.g.id)?.isActive, 0)
      if (tool === 'create_register') assert.equal(f.cfg.listRegisters(f.g.id).length, 2)
      if (tool === 'create_alarm_rule') assert.equal(f.cfg.listRules().length, 2)
      if (tool === 'update_alarm_rule') assert.equal(f.cfg.listRules()[0].threshold, 3)
      if (tool === 'delete_alarm_rule') assert.equal(f.cfg.listRules().length, 0)
    } finally { http.createServer = create; await client?.close(); await sdk?.close(); await ctx.fiber.dispose(); await f.cfg.close(); assert.equal(httpServer.closes, 1) }
  })
  await run('REST-envelope', async () => {
    const f = fixture(), app = Fastify()
    try {
      app.post('/synthetic', async () => f.cfg.createObject('rest', 'mock.invalid', 502)); f.arm()
      const response = await app.inject({ method: 'POST', url: '/synthetic' }); assert.equal(response.statusCode, 409); const value = response.json(); assert.deepEqual(Object.keys(value).sort(), ['code','error','message','statusCode']); assert.equal(value.code, 'SYNTHETIC_NOTIFY'); assert(committed(new Error(value.message))); assert.equal(f.cfg.listObjects().length, 2)
    } finally { await app.close(); await f.cfg.close() }
  })
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, []); assert.deepEqual(failures, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', onUnhandled) }
console.log('CONFIG NOTIFICATION TEST OK: ' + cases.length + ' native-memory, transaction/fault, SDK memory and Fastify.inject cases; original SQL/transaction errors remain uncertain, no sockets, user data, hardware or model')
