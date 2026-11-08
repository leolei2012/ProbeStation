import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as rulePlugin from '../packages/rule/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

class Socket extends EventEmitter {
  readyState = 1; terminated = 0; messages: any[] = []
  send(text: string) { this.messages.push(JSON.parse(text)) }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close') }
}
const tick = () => new Promise<void>(done => setImmediate(done))
let passed = 0
async function scenario(mode: 'insert' | 'prune' | 'exporter' | 'normal', test: (fixture: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'probestation-alarm-log-')), ctx = new Context(), warnings: string[] = [], events: any[] = [], socket = new Socket()
  let cfg: any, store: any, app: any
  try {
    ctx.logger.exporter({ export(message) { if (message.name === 'rule' && message.type === 'warn') { warnings.push(message.args.join(' ')); if (mode === 'exporter') throw Error('synthetic fallback exporter failure') } } })
    await ctx.plugin(configPlugin, { dbPath: ':memory:' })
    await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
    cfg = ctx.get('config', false); store = ctx.get('store', false); await store.ready; await store.mutations
    const device = cfg.createObject('synthetic alarm', 'mock.invalid', 502, 'master'), group = cfg.createGroup(device.id, 'synthetic', 3, 0, 4)
    const registers = [cfg.createRegister(group.id, device.id, 'first', 3, 0, 'uint16'), cfg.createRegister(group.id, device.id, 'second', 3, 1, 'uint16'), cfg.createRegister(group.id, device.id, 'wide', 3, 2, 'uint32')]
    const rules = registers.map((reg, i) => cfg.createRule(reg.id, '>', i === 2 ? 65535 : 5, 'synthetic alarm ' + i))
    await ctx.plugin(rulePlugin)
    await ctx.plugin({ name: 'inert-alarm-log-api-services', apply(context: Context) { for (const name of ['poller', 'sink', 'importer', 'ota']) context.provide(name as any, {} as any) } })
    await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: directory })
    app = ctx.get('api', false); let ws: ((socket: Socket) => void) | undefined
    app.addHook('onRoute', (route: any) => { if (route.url === '/ws' && route.websocket) ws = route.handler })
    await app.ready(); assert(ws); ws(socket)
    ctx.on('rule/trigger', event => events.push(event))
    if (mode === 'insert' || mode === 'exporter') cfg.db.exec("CREATE TRIGGER synthetic_log_insert BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT, 'synthetic-private-log-failure'); END")
    if (mode === 'prune') {
      cfg.db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10099) INSERT INTO logs(ts,level,source,message) SELECT '2026-11-08T00:00:00Z','INFO','synthetic','seed' FROM n")
      cfg.db.exec("CREATE TRIGGER synthetic_log_prune BEFORE DELETE ON logs BEGIN SELECT RAISE(ABORT, 'synthetic-private-prune-failure'); END")
    }
    const emit = (values = [10, 20, 0, 0], mixed = false) => {
      const timestamp = new Date().toISOString()
      ;(ctx as any).emit('poller/result', { objectId: device.id, points: values.map((rawValue, address) => ({ objectId: device.id, area: 'holding-register', address, rawValue, quality: 'good', timestamp, slaveId: 1, batchId: mixed && address === 3 ? 'other' : 'synthetic-response' })) })
    }
    await test({ cfg, store, app, ctx, events, socket, warnings, registers, rules, emit, drop: () => cfg.db.exec('DROP TRIGGER IF EXISTS synthetic_log_insert; DROP TRIGGER IF EXISTS synthetic_log_prune') })
    await ctx.fiber.dispose(); assert.equal(socket.terminated, 1)
    const sent = socket.messages.length; (ctx as any).emit('poller/result', { objectId: device.id, points: [] }); assert.equal(socket.messages.length, sent)
    await ctx.fiber.dispose()
    passed++; console.log('ALARM LOG FAILURE OK: ' + mode + ' through actual config/store/rule/API plugins and a mock socket')
  } finally {
    await ctx.fiber.dispose(); await app?.close(); await store?.close(); await cfg?.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(directory.startsWith(join(tmpdir(), 'probestation-alarm-log-')))
    rmSync(directory, { recursive: true, force: true })
  }
}
await scenario('insert', async ({ emit, events, socket, warnings, cfg, rules, drop, app }) => {
  assert.doesNotThrow(() => emit(), 'log INSERT failure must not abort alarm events or the enclosing sample relay'); await tick()
  assert.deepEqual(events.map((e: any) => e.ruleId), rules.slice(0, 2).map((r: any) => r.id)); assert.equal(cfg.listLogs().length, 0)
  assert.equal(socket.messages.filter((e: any) => e.type === 'rule/trigger').length, 2); assert.equal(socket.messages.filter((e: any) => e.type === 'poller/result').length, 1)
  assert.equal(warnings.length, 2); assert(warnings.every((text: string) => text.includes('日志') && text.includes('待核实') && !text.includes('synthetic-private')))
  assert(warnings.every((text: string, i: number) => text.includes('rule ' + rules[i].id)))
  assert.equal((await app.inject('/health')).statusCode, 200); assert.equal((await app.inject('/ready')).statusCode, 200, 'sample-storage readiness is not an alarm-log health guarantee')
  emit(); assert.equal(events.length, 2); assert.equal(warnings.length, 2, 'continuous alarm still deduplicates, without repeated log attempts')
  drop(); emit(); assert.equal(events.length, 2); assert.equal(cfg.listLogs().length, 0, 'log recovery does not replay already delivered alerts or fabricate old log records')
  emit([0, 0, 0, 0]); emit(); assert.equal(events.length, 4); assert.equal(cfg.listLogs().length, 2, 'normal recovery and rearming remain intact')
})
await scenario('prune', async ({ emit, events, warnings, cfg }) => {
  assert.doesNotThrow(() => emit()); assert.equal(events.length, 2); assert.equal(warnings.length, 1)
  assert.equal(cfg.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE source='rule'").get().n, 2, 'INSERT committed before a failing cleanup may already have persisted the log')
  assert(warnings[0].includes('待核实')); assert(!warnings[0].includes('未保存')); assert(!warnings[0].includes('synthetic-private'))
})
await scenario('exporter', async ({ emit, events, socket, warnings }) => {
  assert.doesNotThrow(() => emit()); assert.equal(events.length, 2); assert.equal(warnings.length, 2)
  assert.equal(socket.messages.filter((e: any) => e.type === 'rule/trigger').length, 2, 'fallback logger failure must not suppress alarm delivery')
})
await scenario('normal', async ({ emit, events, warnings, cfg, rules }) => {
  emit([10, 20, 1, 0], true); assert.equal(events.length, 2, 'mixed response words remain unknown')
  emit([10, 20, 1, 0]); assert.equal(events.length, 3); assert.equal(events[2].ruleId, rules[2].id); assert.equal(events[2].value, 65536)
  assert.equal(events[2].slaveId, 1); assert.equal(cfg.listLogs().length, 3); assert.equal(warnings.length, 0)
  assert.deepEqual(Object.keys(events[0]).sort(), ['ruleId', 'objectId', 'registerId', 'value', 'operator', 'threshold', 'message', 'timestamp', 'slaveId'].sort())
})
assert.equal(passed, 4)
console.log('ALARM LOG FAILURE TEST OK: 4 actual plugin assemblies, real in-memory INSERT/prune faults, dedupe/rearm and mock WS relay; no listeners, drivers, models, real databases or hardware')
