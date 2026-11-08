import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { Context } from 'cordis'
import ts from 'typescript'
import { ConfigStore, type DeviceRecord, type GroupRecord } from '../packages/config/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'

// This audit asserts a known limitation, not a guarantee that early events are desirable.
// Raw transaction access below is test-only; ConfigStore exposes no caller transaction API.
assert.deepEqual(process.argv.slice(2), ['--synthetic'], 'Only --synthetic is supported; no database or device arguments are accepted.')
const tick = () => new Promise<void>(done => setImmediate(done))
const tables = ['monitor_objects', 'register_groups', 'registers', 'alarm_rules', 'logs']
const graph = (db: DatabaseSync) => JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])))
type Event = { scope: string; id?: number }
type Observation = { transaction: boolean; writer: string; reader: string }
const capture = (action: () => unknown) => { try { action(); return undefined } catch (error) { return error } }
const passed: string[] = [], denied: string[] = [], unhandled: unknown[] = []
const observeUnhandled = (error: unknown) => { unhandled.push(error) }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('Unexpected real I/O: ' + name) }

// Execute the production relay registration with an in-memory broadcast recipient only.
const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let relay: ts.CallExpression | undefined
function findRelay(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(apiSource) === 'ctx.on' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'config/changed') {
    assert.equal(relay, undefined); relay = node
  }
  ts.forEachChild(node, findRelay)
}
findRelay(apiSource)
assert(relay)
const relayCode = ts.transpileModule(relay.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'probestation-outer-audit-')), file = join(directory, 'synthetic.sqlite'), ctx = new Context()
  const cfg = new ConfigStore({ dbPath: file }, (scope, id) => ctx.emit('config/changed', { scope, id }))
  // Narrow test adapter, never a supported application integration pattern.
  const db = (cfg as unknown as { db: DatabaseSync }).db
  const device = cfg.createObject('target', 'first.mock.invalid', 502)
  const keep = cfg.createObject('untouched', 'keep.mock.invalid', 502)
  const group = cfg.createGroup(device.id, 'target', 3, 0, 2), other = cfg.createGroup(keep.id, 'untouched', 3, 0, 1)
  const point = cfg.createRegister(group.id, device.id, 'target', 3, 0, 'uint16')
  cfg.createRegister(group.id, device.id, 'second', 3, 1, 'uint16')
  const keepPoint = cfg.createRegister(other.id, keep.id, 'untouched', 3, 0, 'uint16')
  cfg.createRule(point.id, '>', 1, 'target'); cfg.createRule(keepPoint.id, '>', 1, 'untouched')
  const reader = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=0'); reader.exec('PRAGMA busy_timeout=0')
  const events: Observation[] = [], wire: Event[] = []
  ctx.on('config/changed', () => events.push({ transaction: db.isTransaction, writer: graph(db), reader: graph(reader) }))
  new Function('ctx', 'broadcast', relayCode)(ctx, (message: string) => wire.push(JSON.parse(message)))
  ctx.provide('config', cfg)
  return {
    ctx, cfg, db, reader, device, group, point, keep, events, wire,
    async close() {
      if (reader.isTransaction) reader.exec('ROLLBACK')
      if (db.isTransaction) db.exec('ROLLBACK')
      await ctx.fiber.dispose(); reader.close(); await cfg.close()
      const target = resolve(directory)
      assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase())
      assert(basename(target).startsWith('probestation-outer-audit-'))
      assert(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink())
      rmSync(target, { recursive: true, force: true })
    },
  }
}
async function scenario(name: string, action: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>) {
  const f = await fixture()
  try { await action(f); passed.push(name); console.log('OUTER TRANSACTION AUDIT OK: ' + name) }
  finally { await f.close() }
}

net.Server.prototype.listen = block('listen') as typeof listen
net.Socket.prototype.connect = block('connect') as typeof connect
globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', observeUnhandled)
try {
  for (const kind of ['device', 'group', 'point']) for (const ending of ['COMMIT', 'ROLLBACK']) {
    await scenario(kind + '/' + ending, f => {
      const before = graph(f.db), keep = f.cfg.getObject(f.keep.id)
      f.db.exec('BEGIN')
      if (kind === 'device') f.cfg.deleteObject(f.device.id)
      else if (kind === 'group') f.cfg.deleteGroup(f.group.id)
      else f.cfg.deleteRegister(f.point.id)
      assert.equal(f.db.isTransaction, true, 'delete must not commit its caller transaction')
      assert.equal(f.events.length, 1); assert.equal(f.wire.length, 1)
      assert.equal(f.events[0].transaction, true)
      assert.notEqual(f.events[0].writer, before); assert.equal(f.events[0].reader, before)
      const pending = graph(f.db)
      f.db.exec(ending)
      assert.equal(graph(f.reader), ending === 'COMMIT' ? pending : before)
      assert.equal(graph(f.db), graph(f.reader)); assert.deepEqual(f.cfg.getObject(f.keep.id), keep)
      assert.equal(f.events.length, 1, 'native transaction end sends no completion/retraction event')
      assert.equal(f.wire.length, 1, 'the earlier relay message cannot be withdrawn')
    })
  }
  for (const ending of ['COMMIT', 'ROLLBACK']) await scenario('subscriber-failure/' + ending, f => {
    const failure = Error('synthetic subscriber failed'), before = graph(f.db)
    let skipped = 0
    f.ctx.on('config/changed', () => { throw failure })
    f.ctx.on('config/changed', () => { skipped++ })
    f.db.exec('BEGIN')
    assert.equal(capture(() => f.cfg.deleteGroup(f.group.id)), failure, 'outer transaction errors must not claim an already committed deletion')
    assert.equal(f.db.isTransaction, true); assert.equal(skipped, 0)
    assert.equal(f.events.length, 1); assert.equal(f.wire.length, 1); assert.equal(graph(f.reader), before)
    const pending = graph(f.db)
    f.db.exec(ending)
    assert.equal(graph(f.reader), ending === 'COMMIT' ? pending : before)
    assert.equal(f.events.length, 1); assert.equal(skipped, 0)
  })
  await scenario('caller-savepoint-rollback-then-commit', f => {
    const before = graph(f.db)
    f.db.exec('BEGIN; SAVEPOINT caller_inner')
    f.cfg.deleteRegister(f.point.id)
    assert.equal(f.events.length, 1); assert.equal(f.wire.length, 1)
    f.db.exec('ROLLBACK TO SAVEPOINT caller_inner; RELEASE SAVEPOINT caller_inner')
    assert.equal(f.db.isTransaction, true); assert.equal(graph(f.db), before)
    f.db.exec('COMMIT')
    assert.equal(graph(f.reader), before); assert.equal(f.events.length, 1)
  })
  for (const ending of ['held-open', 'already-rolled-back']) await scenario('microtask-delay/' + ending, async f => {
    const before = graph(f.db), delayed: Observation[] = []
    f.ctx.on('config/changed', () => { queueMicrotask(() => delayed.push({ transaction: f.db.isTransaction, writer: graph(f.db), reader: graph(f.reader) })) })
    f.db.exec('BEGIN'); f.cfg.deleteGroup(f.group.id)
    if (ending === 'already-rolled-back') f.db.exec('ROLLBACK')
    await tick()
    assert.equal(delayed.length, 1); assert.equal(delayed[0].reader, before)
    assert.equal(delayed[0].transaction, ending === 'held-open')
    if (ending === 'held-open') { assert.notEqual(delayed[0].writer, before); f.db.exec('ROLLBACK') }
    else assert.equal(delayed[0].writer, before)
    assert.equal(f.events.length, 1); assert.equal(f.wire.length, 1)
  })
  for (const kind of ['source', 'deletion']) await scenario('actual-poller/' + kind, async f => {
    let creates = 0, disconnects = 0
    // Required injected services are inert. Driver creation is a hard failure; polling is never started.
    f.ctx.provide('modbus', { createDriver() { creates++; throw Error('No driver is permitted in this audit') } } as never)
    f.ctx.provide('store', {} as never)
    await f.ctx.plugin(pollerPlugin, { pollIntervalMs: 1000, connectRetryMs: 5000, watchdogTimeoutMs: 30000, autoResetFailThreshold: 3, autoResetCooldownMs: 5000 })
    const engine = f.ctx.get('poller', false)
    const state = engine as unknown as { devices: DeviceRecord[]; groupsByDevice: Map<number, GroupRecord[]>; drivers: Map<string, { disconnect(): Promise<void> }> }
    f.cfg.updateObject(f.device.id, { name: 'warm' })
    assert.equal(engine.isRunning(), false)
    assert.equal(state.devices.find(row => row.id === f.device.id)?.ip, 'first.mock.invalid')
    if (kind === 'deletion') state.drivers.set('tcp:' + f.device.id, { async disconnect() { disconnects++ } })
    const before = graph(f.db), eventCount = f.events.length
    f.db.exec('BEGIN')
    if (kind === 'source') f.cfg.updateObject(f.device.id, { ip: 'pending.mock.invalid' })
    else f.cfg.deleteObject(f.device.id)
    assert.equal(state.devices.find(row => row.id === f.device.id)?.ip, kind === 'source' ? 'pending.mock.invalid' : undefined)
    assert.equal(graph(f.reader), before)
    f.db.exec('ROLLBACK')
    assert.equal(graph(f.db), before); assert.equal(graph(f.reader), before)
    assert.equal(state.devices.find(row => row.id === f.device.id)?.ip, kind === 'source' ? 'pending.mock.invalid' : undefined, 'rollback does not refresh the poller cache')
    assert.equal(f.events.length, eventCount + 1); assert.equal(disconnects, kind === 'deletion' ? 1 : 0)
    f.cfg.updateObject(f.device.id, { name: 'warm' }) // Explicit audit recovery, never an automatic application retry.
    assert.equal(state.devices.find(row => row.id === f.device.id)?.ip, 'first.mock.invalid')
    assert.equal(creates, 0); assert.equal(engine.isRunning(), false)
  })
  for (const kind of ['source', 'deletion']) await scenario('actual-recorder/' + kind, async f => {
    const recorder = new Recorder(f.ctx, f.cfg)
    try {
      const id = recorder.startRecording(f.device.id, 100, 60000)
      const point = { area: 'holding-register', address: 0, slaveId: 1, rawValue: 7, timestamp: new Date().toISOString(), quality: 'good', batchId: 'synthetic' }
      f.ctx.emit('poller/result', { objectId: f.device.id, points: [point] })
      assert.equal(recorder.getRecording(id)?.samples.length, 1)
      const before = graph(f.db), eventCount = f.events.length
      f.db.exec('BEGIN')
      if (kind === 'source') f.cfg.updateObject(f.device.id, { ip: 'pending.mock.invalid' })
      else f.cfg.deleteObject(f.device.id)
      assert.equal(recorder.getRecording(id)?.completionReason, 'source-changed')
      assert.equal(recorder.getRecording(id)?.intervalRestore, 'preserved')
      assert.equal(graph(f.reader), before)
      f.db.exec('ROLLBACK')
      assert.equal(graph(f.db), before); assert.equal(graph(f.reader), before)
      assert.equal(f.events.length, eventCount + 1)
      f.ctx.emit('poller/result', { objectId: f.device.id, points: [{ ...point, rawValue: 9 }] })
      const session = recorder.getRecording(id)!
      assert.equal(session.status, 'done'); assert.equal(session.samples.length, 1)
      assert.equal(f.cfg.getObject(f.device.id)?.pollIntervalMs, 100, 'rolled-back source edits must not trigger an unsafe old-period restoration')
      assert.equal(session.intervalRestore, 'preserved')
    } finally { await recorder.close() }
  })
  for (const kind of ['success', 'failure']) await scenario('owned-bulk-control/' + kind, f => {
    const before = graph(f.db)
    if (kind === 'failure') f.db.exec("CREATE TRIGGER synthetic_point_fail BEFORE INSERT ON registers WHEN NEW.start_address=21 BEGIN SELECT RAISE(ABORT,'synthetic insertion failure'); END")
    const error = capture(() => f.cfg.createGroupWithRegisters(f.device.id, 'owned', 3, 20, 2))
    assert.equal(f.db.isTransaction, false)
    if (kind === 'failure') { assert(error); assert.equal(graph(f.db), before); assert.equal(f.events.length, 0); assert.equal(f.wire.length, 0) }
    else {
      assert.equal(error, undefined); assert.equal(f.events.length, 3); assert.equal(f.wire.length, 3)
      assert(f.events.every(event => !event.transaction && event.writer === event.reader && event.reader === graph(f.db)))
    }
  })
  await tick(); assert.deepEqual(denied, []); assert.deepEqual(unhandled, [])
  assert.equal(passed.length, 17)
} finally {
  net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch
  process.off('unhandledRejection', observeUnhandled)
}
console.log('OUTER TRANSACTION AUDIT COMPLETE: 17 synthetic two-connection/Cordis/relay/poller/recorder cases; known limitations reproduced, no production fix or transaction-order change; no real data, polling, network listeners or devices')
