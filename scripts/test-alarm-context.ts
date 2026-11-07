import assert from 'node:assert/strict'
import Fastify from 'fastify'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore, type DeviceRecord } from '../packages/config/src/index.ts'
import { registerAlarmSettings } from '../packages/api/src/alarm-settings.ts'
import { apply as applyMcp } from '../packages/mcp/src/index.ts'
import { captureAlarmContext, parseAlarmContext, alarmContextMatches } from '../packages/core/src/alarm-settings-context.ts'
import { captureAlarmOpening, alarmOpeningState, createAlarm, writeGuardedAlarm } from '../apps/web/src/alarm-settings-save.ts'
import { readDeviceGroups } from '../apps/web/src/config-read.ts'
import { AlarmContextNotice } from '../apps/web/src/AlarmRuleWriteStatus.tsx'

const status = (code: number) => (error: any) => error?.statusCode === code
async function scenario(run: (h: any) => Promise<void> | void, extra: Partial<DeviceRecord> = {}, mode = 'master') {
  let notifications = 0, failNotify = false
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { notifications++; if (failNotify) throw new Error('PRIVATE synthetic failure') }), api = Fastify()
  registerAlarmSettings(api, cfg)
  const d = cfg.createObject('mock context', mode === 'slave' ? '0.0.0.0' : 'before.mock.invalid', 502, mode, extra), g = cfg.createGroup(d.id, 'mock', 3, 0, 8, 'read', 7), p = cfg.createRegister(g.id, d.id, 'mock point', 3, 0, 'uint16')
  const rule = cfg.createRule(p.id, '>', 100, null)
  const context = () => cfg.getAlarmEditContext({ ruleId: rule.id }).expectedContext
  const state = () => JSON.stringify([cfg.listRules(), cfg.listGroups(d.id), cfg.listRegisters(g.id), cfg.getObject(d.id)])
  const fields = { registerId: p.id, operator: '>', threshold: 200, message: null }
  const send = async (url: string, method: string, body: unknown) => { const res = await api.inject({ method: method as 'PUT', url, payload: body }); if (res.statusCode !== 200) throw Object.assign(new Error(res.json().error), { statusCode: res.statusCode }); return res.json() }
  try { await run({ cfg, api, d, g, p, rule, context, state, fields, send, notifications: () => notifications, failNotify: () => { failNotify = true } }) }
  finally { await api.close(); (cfg as any).db.close() }
}
// The old rule-only editor accepted this dtype change and overwrote its raw threshold.
await scenario(({ cfg, p, rule, context, state }) => {
  const expectedContext = context(); cfg.updateRegister(p.id, { dataType: 'uint32' }); const before = state()
  assert.throws(() => cfg.updateRuleSettings(rule.id, { expected: rule, expectedContext, changes: { threshold: 200 } }), status(409)); assert.equal(state(), before)
})
const changes = [
  (h: any) => h.cfg.updateRegister(h.p.id, { dataType: 'uint32-LE' }), (h: any) => h.cfg.updateRegister(h.p.id, { functionCode: 4 }), (h: any) => h.cfg.updateRegister(h.p.id, { startAddress: 1 }),
  ...[{ slaveId: 8 }, { startAddress: 1 }, { quantity: 9 }, { mode: 'write' }, { functionCode: 4 }].map(change => (h: any) => h.cfg.updateGroup(h.g.id, change)),
  ...[{ ip: 'after.mock.invalid' }, { port: 1502 }, { mode: 'slave', ip: '0.0.0.0' }, { transport: 'rtu', serialPath: 'MOCK-ONLY' }].map(change => (h: any) => h.cfg.updateObject(h.d.id, change)),
]
for (const change of changes) await scenario(async h => {
  const expectedContext = h.context(); change(h); const before = h.state(), events = h.notifications()
  await assert.rejects(writeGuardedAlarm(h.rule, { threshold: 200 }, h.send, expectedContext), status(409))
  await assert.rejects(writeGuardedAlarm(h.rule, null, h.send, expectedContext), status(409))
  await assert.rejects(createAlarm(h.fields, h.send, expectedContext), status(409))
  assert.equal(h.state(), before); assert.equal(h.notifications(), events)
})
for (const change of [{ serialPath: 'MOCK-SECOND' }, { baudRate: 19200 }, { parity: 'none' }, { dataBits: 7 }, { stopBits: 2 }, { flowControl: 'rtscts' }]) await scenario(async h => {
  const expectedContext = h.context(); h.cfg.updateObject(h.d.id, change); await assert.rejects(writeGuardedAlarm(h.rule, { threshold: 0 }, h.send, expectedContext), status(409))
}, { transport: 'rtu', serialPath: 'MOCK-FIRST' })
await scenario(async h => {
  const opening = h.context()
  h.cfg.updateRegister(h.p.id, { alias: 'renamed', factor: 0, offset: 4, unit: 'unit', enumJson: 'PRIVATE-LARGE-ENUM', decimalPlaces: 2 })
  h.cfg.updateObject(h.d.id, { name: 'renamed', slaveId: 9, pollIntervalMs: 2500, timeoutMs: 4000, isActive: 0, dataRetainSeconds: 1, serialPath: 'INACTIVE', baudRate: 19200 })
  assert(alarmContextMatches(opening, h.context()), 'display fields, polling state, inactive RTU and unused master default slave do not reinterpret raw alarms')
  const warnings = await writeGuardedAlarm(h.rule, { threshold: 0, message: '' }, h.send, opening); assert.deepEqual(warnings, [])
  const json = JSON.stringify(opening); assert(!json.includes('PRIVATE')); assert(Object.isFrozen(opening.point) && Object.isFrozen(opening.device.connection))
  assert.deepEqual(parseAlarmContext(JSON.parse(json)), opening)
  const groups = await readDeviceGroups(h.d.id, new AbortController().signal, async url => url.endsWith('/groups') ? h.cfg.listGroups(h.d.id) : h.cfg.listRegisters(h.g.id))
  const p = h.cfg.getRegister(h.p.id), d = h.cfg.getObject(h.d.id), captured = captureAlarmOpening(p, groups, d)
  assert(alarmContextMatches(captured, opening)); assert.equal(alarmOpeningState(captured, groups, d), 'ready')
  h.cfg.updateRegister(h.p.id, { dataType: 'uint64' }); const next = [{ ...groups[0], registers: h.cfg.listRegisters(h.g.id) }]
  assert.equal(alarmOpeningState(captured, next, d), 'changed'); assert.equal(alarmOpeningState(captured, [], d), 'unavailable')
  assert.equal(alarmOpeningState(captured, groups, d), 'ready', 'temporary unavailable state never refreshes the original condition')
})
await scenario(async h => {
  const c = h.context(); h.cfg.updateObject(h.d.id, { ip: 'unused.mock.invalid', port: 1502 }); await writeGuardedAlarm(h.rule, { threshold: 0 }, h.send, c)
}, { transport: 'rtu', serialPath: 'MOCK-FIRST' })
await scenario(async h => {
  const c = h.context(); assert.equal(c.device.slaveId, 1); h.cfg.updateGroup(h.g.id, { slaveId: 99 }); assert(alarmContextMatches(c, h.context()))
  h.cfg.updateObject(h.d.id, { slaveId: 8 }); await assert.rejects(writeGuardedAlarm(h.rule, { threshold: 0 }, h.send, c), status(409))
}, {}, 'slave')
await scenario(async h => {
  const c = h.context(), before = h.state()
  for (const bad of [null, {}, { ...c, version: 2 }, { ...c, point: { ...c.point, id: 0 } }, { ...c, group: { ...c.group, id: 999 } }, { ...c, device: { ...c.device, slaveId: undefined } }, { ...c, device: { ...c.device, connection: { ...c.device.connection, secret: 'PRIVATE' } } }]) {
    assert.throws(() => h.cfg.updateRuleSettings(h.rule.id, { expected: h.rule, expectedContext: bad, changes: { threshold: 0 } }), status(400)); assert.equal(h.state(), before)
  }
  assert.throws(() => h.cfg.createRuleSettings({ fields: { ...h.fields, registerId: 999 }, expectedContext: c }), status(400))
  let calls = 0
  await assert.rejects(writeGuardedAlarm(h.rule, { threshold: 0 }, async () => { calls++; return { rule: { ...h.rule, threshold: 0 }, deletedRuleId: null, warnings: [] } }, c), /待核实/); assert.equal(calls, 1)
  await assert.rejects(createAlarm(h.fields, async () => ({ rule: { id: 99, ...h.fields }, warnings: [], protection: 'rule-only' }), c), /待核实/)
  const read = await h.api.inject('/api/rules/' + h.rule.id + '/settings'); assert.equal(read.statusCode, 200); assert.equal(read.headers['cache-control'], 'no-store'); assert.deepEqual(read.json().expectedContext, c)
  assert.equal((await h.api.inject('/api/registers/' + h.p.id + '/alarm-context')).statusCode, 200)
  for (const selection of [null, {}, { ruleId: h.rule.id, registerId: h.p.id }, { ruleId: 0 }]) assert.throws(() => h.cfg.getAlarmEditContext(selection), status(400))
  h.cfg.updateRegister(h.p.id, { dataType: 'uint32' })
  const legacy = h.cfg.updateRuleSettings(h.rule.id, { expected: h.rule, changes: { threshold: 0 } }); assert.equal(legacy.protection, undefined, 'old rule-only settings response shape stays compatible')
})
for (const operation of ['create', 'update', 'delete']) await scenario(async h => {
  const c = h.context(), db = h.cfg.db, before = h.state()
  const when = operation === 'create' ? 'INSERT' : operation === 'update' ? 'UPDATE' : 'DELETE'
  db.exec(`CREATE TRIGGER mock_context AFTER ${when} ON alarm_rules BEGIN UPDATE registers SET data_type='uint64' WHERE id=${h.p.id}; END`)
  assert.throws(() => operation === 'create' ? h.cfg.createRuleSettings({ fields: h.fields, expectedContext: c }) : operation === 'update' ? h.cfg.updateRuleSettings(h.rule.id, { expected: h.rule, expectedContext: c, changes: { threshold: 0 } }) : h.cfg.deleteRuleSettings(h.rule.id, { expected: h.rule, expectedContext: c }), /读回不一致/)
  assert.equal(h.state(), before); db.exec('DROP TRIGGER mock_context')
})
await scenario(async h => {
  const c = h.context(); h.failNotify(); const warnings = await createAlarm(h.fields, h.send, c); assert.equal(warnings.length, 1); assert.equal(h.cfg.listRules().length, 2)
})
const scratchParent = resolve(tmpdir()), scratch = mkdtempSync(join(scratchParent, 'probe-alarm-context-'))
assert.equal(dirname(resolve(scratch)), scratchParent); assert(basename(scratch).startsWith('probe-alarm-context-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  a = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); b = new ConfigStore({ dbPath: join(scratch, 'isolated.db') })
  const d = a.createObject('two connections', 'mock.invalid', 502), g = a.createGroup(d.id, 'mock', 3, 0, 4), p = a.createRegister(g.id, d.id, 'mock', 3, 0), r = a.createRule(p.id, '>', 100, null)
  const snapshot = a.getAlarmEditContext({ ruleId: r.id }), db = (a as any).db, prepare = db.prepare.bind(db); let locked = 0
  db.prepare = (sql: string) => { if (sql.startsWith('UPDATE alarm_rules')) { assert.throws(() => b!.updateRegister(p.id, { dataType: 'uint32' }), /locked|busy/i); locked++ }; return prepare(sql) }
  a.updateRuleSettings(r.id, { ...snapshot, changes: { threshold: 0 } }); db.prepare = prepare; assert.equal(locked, 1); assert.equal(b.getRegister(p.id)!.dataType, 'int16')
  const getPoint = a.getRegister.bind(a); let readLocked = 0
  a.getRegister = id => { if (!readLocked) { readLocked++; assert.throws(() => b!.updateGroup(g.id, { slaveId: 8 }), /locked|busy/i) }; return getPoint(id) }
  const current = a.getAlarmEditContext({ ruleId: r.id }); a.getRegister = getPoint
  assert.equal(current.expectedContext.device.slaveId, 1); assert.equal(readLocked, 1, 'read snapshot must bind rule and source under one SQLite transaction')
  b.updateGroup(g.id, { slaveId: 8 }); assert.throws(() => a!.deleteRuleSettings(r.id, current), status(409))
} finally { if (a) (a as any).db.close(); if (b) (b as any).db.close(); assert.equal(dirname(resolve(scratch)), scratchParent); assert(basename(scratch).startsWith('probe-alarm-context-')); rmSync(scratch, { recursive: true, force: true }) }
await scenario(async h => {
  const handlers = new Map<string, any>(), schemas = new Map<string, any>(), configs = new Map<string, any>(), originalHttp = http.createServer, originalRegister = McpServer.prototype.registerTool
  let factory: any, listens = 0
  try {
    http.createServer = (() => ({ listen: () => { listens++ } })) as any
    McpServer.prototype.registerTool = function(name: string, config: any, handler: any) { assert(!handlers.has(name), 'duplicate production tool registration'); handlers.set(name, handler); schemas.set(name, config.inputSchema); configs.set(name, config); return {} as any } as any
    applyMcp({ config: h.cfg, store: {}, poller: {}, sink: {}, on() {}, provide(_name: string, service: any) { factory = service.createServer } } as any, { host: '127.0.0.1', port: 0 })
    const server = factory(); await server.close()
  } finally { http.createServer = originalHttp; McpServer.prototype.registerTool = originalRegister }
  assert.equal(listens, 1, 'listen was intercepted; no actual socket')
  const run = (name: string, args: any) => handlers.get(name)(args), body = (res: any) => JSON.parse(res.content[0].text)
  let snapshot = body(await run('get_alarm_edit_context', { rule_id: h.rule.id }))
  h.cfg.updateGroup(h.g.id, { slaveId: 9 }); const before = h.state()
  for (const name of ['update_alarm_rule', 'delete_alarm_rule']) { const result = await run(name, { rule_id: h.rule.id, expected_rule: snapshot.expected, expected_context: snapshot.expectedContext, threshold: 0 }); assert.equal(result.isError, true); assert.equal(h.state(), before) }
  assert.equal((await run('update_alarm_rule', { rule_id: h.rule.id, expected_rule: snapshot.expected, threshold: 0 })).isError, true)
  snapshot = body(await run('get_alarm_edit_context', { rule_id: h.rule.id }))
  const saved = await run('update_alarm_rule', { rule_id: h.rule.id, expected_rule: snapshot.expected, expected_context: snapshot.expectedContext, threshold: 0, message: '' }); assert.equal(body(saved).threshold, 0); assert.equal(body(saved).protection, 'rule-and-context')
  const createContext = body(await run('get_alarm_edit_context', { register_id: h.p.id })).expectedContext
  assert.equal(body(await run('create_alarm_rule', { register_id: h.p.id, operator: '<', threshold: 0, expected_context: createContext })).protection, 'rule-and-context')
  const old = await run('update_alarm_rule', { rule_id: h.rule.id, threshold: 3 }); assert.equal(body(old).threshold, 3); assert.equal(body(old).protection, undefined); assert(old.content[1].text.includes('兼容调用'))
  snapshot = body(await run('get_alarm_edit_context', { rule_id: h.rule.id })); assert.equal(body(await run('delete_alarm_rule', { rule_id: h.rule.id, expected_rule: snapshot.expected, expected_context: snapshot.expectedContext })).protection, 'rule-and-context')
  assert(schemas.get('update_alarm_rule').expected_context); assert.equal((await run('get_alarm_edit_context', {})).isError, true)
  const server = new McpServer({ name: 'alarm-context-test', version: '1' }), client = new Client({ name: 'alarm-context-test', version: '1' }), transports = InMemoryTransport.createLinkedPair()
  for (const name of ['get_alarm_edit_context', 'create_alarm_rule', 'update_alarm_rule', 'delete_alarm_rule']) server.registerTool(name, configs.get(name), handlers.get(name))
  try {
    await Promise.all([server.connect(transports[0]), client.connect(transports[1])])
    const listed = await client.listTools(); assert.equal(listed.tools.find(tool => tool.name === 'get_alarm_edit_context')?.annotations?.readOnlyHint, true)
    const call = (name: string, args: any) => client.callTool({ name, arguments: args })
    const ctx = body(await call('get_alarm_edit_context', { register_id: h.p.id })).expectedContext
    const created = body(await call('create_alarm_rule', { register_id: h.p.id, operator: '>', threshold: 0, expected_context: ctx })); assert.equal(created.protection, 'rule-and-context')
    const captured = body(await call('get_alarm_edit_context', { rule_id: created.id }))
    assert.equal(body(await call('update_alarm_rule', { rule_id: created.id, threshold: -2, expected_rule: captured.expected, expected_context: captured.expectedContext })).threshold, -2)
    assert.equal((await call('delete_alarm_rule', { rule_id: created.id, expected_rule: captured.expected, expected_context: captured.expectedContext })).isError, true, 'real SDK preserves stale conditions')
    assert.equal((await call('update_alarm_rule', { rule_id: created.id, threshold: 1, expected_context: null })).isError, true, 'partial/null fields cannot downgrade to a legacy call')
    const latest = body(await call('get_alarm_edit_context', { rule_id: created.id })); assert.equal(body(await call('delete_alarm_rule', { rule_id: created.id, expected_rule: latest.expected, expected_context: latest.expectedContext })).ok, true)
  } finally { await client.close(); await server.close() }
})
for (const english of [false, true]) { const html = renderToStaticMarkup(createElement(AlarmContextNotice, { state: 'changed', english })); assert(html.includes(english ? 'draft' : '草稿')); assert(html.includes('role="alert"')) }
console.log('ALARM CONTEXT OK: dtype/address/group/source repro, TCP/RTU/role/slave semantics, unused-field compatibility, strict snapshots/no downgrade, create/update/delete rollback and warnings, real frontend projection/frozen recovery, temp dual-connection lock, production MCP conditional/legacy compatibility and SSR; no real database, sockets, hardware or model')
