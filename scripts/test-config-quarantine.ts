import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import net from 'node:net'
import Fastify from 'fastify'
import { Context } from 'cordis'
import { ConfigStore } from '../packages/config/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import { registerGroupSettings } from '../packages/api/src/group-settings.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'

const caught = (action: () => unknown) => { try { action(); return undefined } catch (error) { return error } }
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target)) || error instanceof Error && contains(error.cause, target)
const blocked = (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'CONFIG_TRANSACTION_UNCONFIRMED'
const tables = ['monitor_objects', 'register_groups', 'registers', 'alarm_rules', 'logs', 'firmwares']
const graph = (db: DatabaseSync) => JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])))
const passed: string[] = [], failures: string[] = [], denied: string[] = [], unhandled: unknown[] = []
const tick = () => new Promise<void>(done => setImmediate(done))
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'probestation-config-quarantine-')), file = join(directory, 'synthetic.sqlite')
  let db!: DatabaseSync, armed = false, notifyFailure = false
  const events: { scope: string; transaction: boolean }[] = []
  const observerFailure = Error('synthetic observer failure')
  const cfg = new ConfigStore({ dbPath: file }, scope => { if (armed) { events.push({ scope, transaction: db.isTransaction }); if (notifyFailure) throw observerFailure } })
  const d = cfg.createObject('target', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'target', 3, 0, 2)
  const p = cfg.createRegister(g.id, d.id, 'target', 3, 0, 'uint16'), tail = cfg.createRegister(g.id, d.id, 'tail', 3, 1, 'uint16')
  const rule = cfg.createRule(tail.id, '>', 1, 'synthetic')
  cfg.log('INFO', 'synthetic', 'keep'); const firmware = cfg.createFirmware('synthetic', '1', 1, 0, 'not-a-file')
  db = (cfg as unknown as { db: DatabaseSync }).db
  const reader = new DatabaseSync(file, { readOnly: true }), initial = graph(db)
  const baseline = { device: captureDeviceEditBaseline(d), group: cfg.getGroupSettings(g.id), point: cfg.getRegisterSettings(p.id), alarm: cfg.getAlarmEditContext({ ruleId: rule.id }), newAlarm: cfg.getAlarmEditContext({ registerId: p.id }), backup: cfg.exportBackup(), cleanup: cfg.previewLogCleanup() }
  let originalExec = db.exec.bind(db), originalClose = db.close.bind(db)
  const commitFailure = Error('synthetic commit failure'), rollbackFailure = Error('synthetic rollback failure')
  const fault = (ack = false) => { db.exec = sql => { if (sql === 'COMMIT') { if (ack) originalExec(sql); throw commitFailure }; if (sql === 'ROLLBACK') throw rollbackFailure; return originalExec(sql) } }
  const restore = () => { db.exec = originalExec; db.close = originalClose }
  const resize = () => {
    const changes = { quantity: 1 }, plan = planGroupResize(baseline.group, parseGroupEditChanges(changes, baseline.group.group))
    return cfg.updateGroupSettings(g.id, { expectedRevision: baseline.group.revision, changes, confirmedDeletion: { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } })
  }
  return {
    cfg, d, g, p, tail, rule, firmware, baseline, file, directory, reader, initial, events, observerFailure, commitFailure, rollbackFailure, fault, restore, resize,
    native: () => db, arm: () => { armed = true }, failNotify: (value: boolean) => { notifyFailure = value },
    reopen() { restore(); cfg.reopen(file); db = (cfg as unknown as { db: DatabaseSync }).db; originalExec = db.exec.bind(db); originalClose = db.close.bind(db) },
    async close() {
      restore(); if (db.isOpen && db.isTransaction) originalExec('ROLLBACK'); await cfg.close(); reader.close()
      const target = resolve(directory); assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase()); assert(basename(target).startsWith('probestation-config-quarantine-')); assert(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()); rmSync(target, { recursive: true, force: true })
    },
  }
}
async function test(name: string, action: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>) {
  const f = await fixture()
  try { await action(f); passed.push(name); console.log('CONFIG QUARANTINE OK: ' + name) }
  catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('CONFIG QUARANTINE REPRO: ' + failures.at(-1)) }
  finally { await f.close() }
}
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('Unexpected real I/O: ' + name) }
const rejectUnhandled = (error: unknown) => { unhandled.push(error) }
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', rejectUnhandled)
try {
  await test('all-public-database-paths-and-sticky-gate', f => {
    const { cfg, d, g, p, tail, rule, baseline: b } = f
    const lease = cfg.acquireRecordingInterval(d.id, 100).lease, source = cfg.captureRecordingSource(d.id)
    // Refresh the group revision after the legitimate interval change.
    const group = cfg.getGroupSettings(g.id), plan = planGroupResize(group, { quantity: 1 })
    f.arm(); f.fault()
    const first = caught(() => cfg.updateGroupSettings(g.id, { expectedRevision: group.revision, changes: { quantity: 1 }, confirmedDeletion: { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } }))
    assert(first instanceof AggregateError && contains(first, f.commitFailure) && contains(first, f.rollbackFailure)); f.restore()
    assert.equal(f.native().isTransaction, true); assert.equal(f.events.length, 0)
    const pending = graph(f.native()), prepare = f.native().prepare.bind(f.native()), exec = f.native().exec.bind(f.native())
    let sql = 0; f.native().prepare = text => { sql++; return prepare(text) }; f.native().exec = text => { sql++; return exec(text) }
    const writes: Record<string, () => unknown> = {
      createObject: () => cfg.createObject('blocked', 'mock.invalid', 502), updateObject: () => cfg.updateObject(d.id, { name: 'blocked' }), deleteObject: () => cfg.deleteObject(d.id), toggleObject: () => cfg.toggleObject(d.id), updateObjectSettings: () => cfg.updateObjectSettings(d.id, { expected: b.device, changes: { name: 'blocked' } }),
      createGroup: () => cfg.createGroup(d.id, 'blocked', 3, 20, 1), createGroupWithRegisters: () => cfg.createGroupWithRegisters(d.id, 'blocked', 3, 20, 1), updateGroup: () => cfg.updateGroup(g.id, { name: 'blocked' }), updateGroupSettings: () => cfg.updateGroupSettings(g.id, { expectedRevision: group.revision, changes: { name: 'blocked' } }), deleteGroup: () => cfg.deleteGroup(g.id), toggleGroup: () => cfg.toggleGroup(g.id),
      createRegister: () => cfg.createRegister(g.id, d.id, 'blocked', 3, 0), updateRegister: () => cfg.updateRegister(p.id, { alias: 'blocked' }), updateRegisterSettings: () => cfg.updateRegisterSettings(p.id, { expected: b.point, changes: { alias: 'blocked' } }), deleteRegister: () => cfg.deleteRegister(tail.id),
      createRule: () => cfg.createRule(p.id, '>', 1, 'blocked'), updateRule: () => cfg.updateRule(rule.id, { registerId: tail.id, operator: '>', threshold: 2, message: 'blocked' }), deleteRule: () => cfg.deleteRule(rule.id), createRuleSettings: () => cfg.createRuleSettings({ fields: { registerId: p.id, operator: '>', threshold: 1, message: 'blocked' }, expectedContext: b.newAlarm.expectedContext }), updateRuleSettings: () => cfg.updateRuleSettings(rule.id, { ...b.alarm, changes: { threshold: 2 } }), deleteRuleSettings: () => cfg.deleteRuleSettings(rule.id, b.alarm),
      restoreBackup: () => cfg.restoreBackup(b.backup), importPoints: () => cfg.importPoints(d.id, [{ functionCode: 3, address: 0, alias: 'blocked' }]), appendImportedPoints: () => cfg.appendImportedPoints(d.id, [], []), applyPointBookImport: () => cfg.applyPointBookImport(d.id, true, () => { throw Error('builder must not execute') }),
      log: () => cfg.log('INFO', 'synthetic', 'blocked'), clearLogs: () => cfg.clearLogs(), createFirmware: () => cfg.createFirmware('blocked', null, 1, 0, null), setFirmwarePath: () => cfg.setFirmwarePath(f.firmware.id, 'blocked'), deleteFirmware: () => cfg.deleteFirmware(f.firmware.id), acquireInterval: () => cfg.acquireRecordingInterval(d.id, 100), restoreInterval: () => cfg.restoreRecordingInterval(lease), validInterval: () => cfg.recordingIntervalLeaseValid(lease),
    }
    try {
      for (const [name, action] of Object.entries(writes)) { const error = caught(action); assert(blocked(error), name + ' must reject before SQL'); assert(contains((error as Error).cause, first), name + ' must retain the original failure'); assert.equal(sql, 0, name) }
      const cleanupError = caught(() => cfg.cleanupReviewedLogs({ expected: b.cleanup })); assert(cleanupError); assert.equal(sql, 0)
      assert(blocked(caught(() => cfg.listObjects()))); assert(blocked(caught(() => cfg.exportBackup()))); assert.equal(sql, 0)
      assert.equal(cfg.recordingSourceMatches(source), false); assert.equal(f.events.length, 0)
    } finally { f.native().prepare = prepare; f.native().exec = exec }
    assert.equal(graph(f.native()), pending)
    f.native().exec('ROLLBACK'); assert(blocked(caught(() => cfg.log('INFO', 'synthetic', 'still blocked'))), 'raw cleanup is not an authorized recovery signal')
    f.reopen(); assert.equal(cfg.getObject(d.id)?.pollIntervalMs, 100); cfg.log('INFO', 'synthetic', 'explicitly recovered')
  })
  for (const ack of [false, true]) await test('reopen-and-commit-ack/' + ack, f => {
    f.arm(); f.fault(ack); const first = caught(f.resize); f.restore()
    assert(first instanceof AggregateError && contains(first, f.commitFailure) && contains(first, f.rollbackFailure)); assert.equal(f.native().isTransaction, !ack)
    assert(blocked(caught(() => f.cfg.deleteGroup(f.g.id)))); assert.equal(f.events.length, 0)
    f.reopen(); assert.equal(f.cfg.listRegisters(f.g.id).length, ack ? 1 : 2)
    assert.equal(f.events.length, 0, 'reopen does not replay notifications or failed mutations')
    f.cfg.updateObject(f.d.id, { name: 'after recovery' }); assert.deepEqual(f.events.map(event => event.transaction), [false])
  })
  await test('normal-rollback-and-notification-failure-do-not-quarantine', f => {
    f.arm(); const exec = f.native().exec.bind(f.native())
    f.native().exec = sql => { if (sql === 'COMMIT') throw f.commitFailure; return exec(sql) }
    assert.equal(caught(f.resize), f.commitFailure); f.restore(); assert.equal(graph(f.native()), f.initial); assert.equal(f.events.length, 0)
    f.failNotify(true); const failure = caught(() => f.cfg.updateObject(f.d.id, { name: 'committed' })); assert(failure instanceof Error && failure.cause === f.observerFailure)
    f.failNotify(false); f.cfg.updateObject(f.d.id, { name: 'still writable' }); assert.equal(f.cfg.getObject(f.d.id)?.name, 'still writable')
  })
  await test('legitimate-outer-transaction-and-savepoint', f => {
    f.arm(); f.native().exec('BEGIN'); f.cfg.deleteRegister(f.tail.id); assert.equal(f.native().isTransaction, true); assert.equal(f.events[0].transaction, true)
    f.native().exec('ROLLBACK'); assert.equal(graph(f.native()), f.initial)
    f.native().exec('BEGIN'); f.native().prepare('UPDATE monitor_objects SET name=? WHERE id=?').run('caller-kept', f.d.id)
    f.native().exec(`CREATE TEMP TRIGGER synthetic_block BEFORE DELETE ON registers WHEN OLD.id=${f.tail.id} BEGIN SELECT RAISE(ABORT,'synthetic delete'); END`)
    assert(caught(() => f.cfg.deleteRegister(f.tail.id))); assert.equal(f.native().isTransaction, true); assert.equal(f.cfg.getObject(f.d.id)?.name, 'caller-kept'); f.native().exec('COMMIT')
    assert.equal(f.cfg.getRegister(f.tail.id)?.id, f.tail.id)
  })
  for (const outer of [false, true]) await test('savepoint-cleanup/' + outer, f => {
    f.arm(); const db = f.native(), exec = db.exec.bind(db)
    db.exec(`CREATE TEMP TRIGGER synthetic_block BEFORE DELETE ON registers WHEN OLD.id=${f.tail.id} BEGIN SELECT RAISE(ABORT,'synthetic delete'); END`)
    if (outer) exec('BEGIN')
    let wholeRollbacks = 0
    db.exec = sql => { if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) throw f.rollbackFailure; if (sql === 'ROLLBACK') wholeRollbacks++; return exec(sql) }
    const first = caught(() => f.cfg.deleteRegister(f.tail.id)); f.restore(); assert(first instanceof AggregateError && contains(first, f.rollbackFailure)); assert.equal(wholeRollbacks, outer ? 0 : 1); assert.equal(f.events.length, 0)
    if (outer) { assert.equal(db.isTransaction, true); assert(blocked(caught(() => f.cfg.createGroup(f.d.id, 'blocked', 3, 20, 1)))); exec('ROLLBACK'); f.reopen() }
    else assert.equal(f.cfg.getRegister(f.tail.id)?.id, f.tail.id, 'confirmed root rollback remains usable')
  })
  await test('read-transaction-failure-quarantines-all-database-access', f => {
    f.fault(); const first = caught(() => f.cfg.getHistoryExportConfiguration(f.d.id)); f.restore()
    assert(first instanceof AggregateError && contains(first, f.rollbackFailure)); assert(blocked(caught(() => f.cfg.createFirmware('blocked', null, 1, 0, null))))
    f.reopen(); assert(f.cfg.getHistoryExportConfiguration(f.d.id)); assert.equal(f.events.length, 0)
  })
  await test('recording-interval-failure-shares-gate', f => {
    const guard = f.cfg.captureRecordingSource(f.d.id); f.arm(); f.fault()
    const first = caught(() => f.cfg.acquireRecordingInterval(f.d.id, 100)); f.restore()
    assert(first instanceof AggregateError && contains(first, f.commitFailure) && contains(first, f.rollbackFailure)); assert.equal(f.cfg.recordingSourceMatches(guard), false)
    assert(blocked(caught(() => f.cfg.updateObject(f.d.id, { name: 'blocked' })))); assert.equal(f.events.length, 0)
    f.reopen(); assert.equal(f.cfg.getObject(f.d.id)?.pollIntervalMs, 1000)
  })
  await test('backup-rollback-preserves-both-errors', f => {
    f.arm(); f.fault(); const first = caught(() => f.cfg.restoreBackup(f.baseline.backup)); f.restore()
    assert(first instanceof AggregateError && contains(first, f.commitFailure) && contains(first, f.rollbackFailure)); assert(blocked(caught(() => f.cfg.clearLogs()))); assert.equal(f.events.length, 0)
    f.reopen(); assert.equal(graph(f.native()), f.initial)
  })
  await test('failed-reopen-does-not-clear-quarantine', f => {
    f.fault(); assert(caught(f.resize)); f.restore(); const closeFailure = Error('synthetic close failure'), nativeClose = f.native().close.bind(f.native())
    f.native().close = () => { throw closeFailure }
    assert.equal(caught(() => f.cfg.reopen(f.file)), closeFailure); assert(blocked(caught(() => f.cfg.listObjects())))
    f.native().close = nativeClose
    assert(caught(() => f.cfg.reopen(f.directory))); assert(blocked(caught(() => f.cfg.listObjects())))
    f.reopen(); assert.equal(graph(f.native()), f.initial)
  })
  await test('terminal-close-releases-quarantined-native-connection', async f => {
    f.fault(); assert(caught(f.resize)); f.restore(); const closing = f.cfg.close(); assert.equal(f.cfg.close(), closing); await closing
    assert.equal(f.native().isOpen, false); assert.equal(graph(f.reader), f.initial); assert(caught(() => f.cfg.reopen(f.file)))
  })
  await test('actual-next-request-is-rejected-without-notification', async f => {
    const app = Fastify(); registerGroupSettings(app, f.cfg)
    app.delete('/synthetic/groups/:id', request => { f.cfg.deleteGroup(Number((request.params as { id: string }).id)); return { ok: true } })
    try {
      f.arm(); f.fault(); const plan = planGroupResize(f.baseline.group, { quantity: 1 })
      const first = await app.inject({ method: 'PUT', url: '/api/groups/' + f.g.id + '/settings', payload: { expectedRevision: f.baseline.group.revision, changes: { quantity: 1 }, confirmedDeletion: { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } } }); f.restore(); assert.equal(first.statusCode, 500)
      const second = await app.inject({ method: 'DELETE', url: '/synthetic/groups/' + f.g.id }); assert.equal(second.statusCode, 503); assert.equal(second.json().code, 'CONFIG_TRANSACTION_UNCONFIRMED'); assert.equal(f.events.length, 0)
      assert.equal(graph(f.reader), f.initial)
    } finally { await app.close() }
  })
  await test('poller-cached-rtu-cleanup-retains-unknown-source-without-io', async f => {
    const ctx = new Context(); let creates = 0, disconnects = 0
    ctx.provide('config', f.cfg); ctx.provide('store', {} as never)
    ctx.provide('modbus', { createDriver() { creates++; throw Error('No real driver is allowed') } } as never)
    try {
      await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000, connectRetryMs: 5000, watchdogTimeoutMs: 30000, autoResetFailThreshold: 3, autoResetCooldownMs: 5000 })
      const engine = ctx.get('poller', false)
      const state = engine as unknown as { drivers: Map<string, { disconnect(): Promise<void> }>; groupsByDevice: Map<number, unknown[]>; releaseUnusedRtuDrivers(): void; pollNextGroup(device: unknown): Promise<void> }
      state.drivers.set('rtu:MOCK-ONLY', { async disconnect() { disconnects++ } }); state.groupsByDevice.set(f.d.id, [f.baseline.group.group])
      f.fault(); assert(caught(f.resize)); f.restore()
      assert.doesNotThrow(() => state.releaseUnusedRtuDrivers(), 'configuration quarantine must not escape the watchdog cleanup callback')
      assert.equal(disconnects, 0); assert(state.drivers.has('rtu:MOCK-ONLY'))
      await state.pollNextGroup(f.d); assert.equal(creates, 0); assert.equal(engine.isRunning(), false)
      f.reopen(); state.releaseUnusedRtuDrivers(); await tick(); assert.equal(disconnects, 1); assert.equal(creates, 0)
    } finally { await ctx.fiber.dispose() }
  })
  await tick(); assert.deepEqual(denied, []); assert.deepEqual(unhandled, []); assert.deepEqual(failures, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', rejectUnhandled) }
console.log('CONFIG QUARANTINE TEST OK: ' + passed.length + ' isolated recovery/normal/nested/notification/close and public-path matrix cases; no real data, network listeners or devices')
