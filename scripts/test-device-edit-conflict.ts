import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerDeviceSettings } from '../packages/api/src/device-settings.ts'
import { captureDeviceEditBaseline, deviceEditMatches, parseDeviceEditRequest } from '../packages/core/src/device-settings-edit.ts'
import { saveGuardedDeviceSettings } from '../apps/web/src/device-settings-save.ts'
import { DeviceModal } from '../apps/web/src/DeviceModal.tsx'

let events = 0, failNotify = false, failReconnect = false, failSync = false
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++; if (failNotify) throw new Error('synthetic notify failure') }), app = Fastify(), calls: string[] = []
registerDeviceSettings(app, cfg, { reconnect: async id => { assert.ok(cfg.getObject(id)); calls.push('reconnect:' + id); if (failReconnect) throw new Error('synthetic reconnect failure') }, syncSlaves: async () => { calls.push('sync'); if (failSync) throw new Error('synthetic sync failure') } })
const device = cfg.createObject('synthetic device', 'old.mock.invalid', 502), capture = () => captureDeviceEditBaseline(cfg.getObject(device.id))
const fields = (expected = capture()) => { const { id: _id, ...changes } = expected; return changes }
const send = (expected: unknown, changes: unknown, url = '/api/monitor_objects/' + device.id + '/settings') => app.inject({ method: 'PUT', url, payload: { expected, changes } })
const snapshot = () => JSON.stringify([cfg.listObjects(), cfg.listGroups(device.id), cfg.listRegistersByObject(device.id), cfg.listRules()])
try {
  const opened = capture(); cfg.updateObject(device.id, { ip: 'new.mock.invalid' })
  let before = snapshot(), count = events, hooks = calls.length
  const rejected = await send(opened, { ...fields(opened), name: 'stale rename' })
  assert.equal(rejected.statusCode, 409); assert.match(rejected.json().error, /草稿已保留/)
  assert.equal(snapshot(), before); assert.equal(events, count); assert.equal(calls.length, hooks)
  assert.equal(cfg.getObject(device.id)!.ip, 'new.mock.invalid')
  const fresh = capture(), changes = { ...fields(fresh), name: 'fresh rename' }
  const saved = await send(fresh, changes)
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().device.name, 'fresh rename'); assert.deepEqual(saved.json().warnings, [])
  assert.deepEqual(calls.slice(hooks), ['reconnect:' + device.id, 'sync']); assert.equal(events, count + 1)
  hooks = calls.length
  assert.equal((await send(fresh, changes)).statusCode, 409); assert.equal(calls.length, hooks)

  // Fields outside the editor remain independent and are never reset from a stale window.
  const independent = capture(); cfg.toggleObject(device.id); cfg.updateObject(device.id, { dataRetainSeconds: 3600 })
  assert.equal((await send(independent, { ...fields(independent), name: 'retention kept' })).statusCode, 200)
  assert.equal(cfg.getObject(device.id)!.isActive, 0); assert.equal(cfg.getObject(device.id)!.dataRetainSeconds, 3600)
  assert.equal(Object.hasOwn(capture(), 'isActive'), false); assert.equal(Object.hasOwn(capture(), 'dataRetainSeconds'), false)
  const g = cfg.createGroup(device.id, 'synthetic', 3, 0, 1), p = cfg.createRegister(g.id, device.id, 'keep point', 3, 0, 'uint16')
  cfg.createRule(p.id, '>', 12, 'keep alarm')
  const children = JSON.stringify([cfg.listGroups(device.id), cfg.listRegistersByObject(device.id), cfg.listRules()])
  const original = cfg.getObject(device.id)!
  for (const change of [{ name: 'concurrent' }, { ip: 'other.mock.invalid' }, { port: 503 }, { mode: 'slave', ip: '127.0.0.1' }, { serialPath: 'SYNTHETIC_PATH_ONLY' }, { baudRate: 19200 }, { parity: 'odd' }, { stopBits: 2 }, { dataBits: 7 }, { flowControl: 'rtscts' }, { slaveId: 8 }, { pollIntervalMs: 2000 }, { timeoutMs: 7000 }, { transport: 'rtu', serialPath: 'SYNTHETIC_PATH_ONLY' }]) {
    const baseline = capture(); cfg.updateObject(device.id, change); before = snapshot(); count = events; hooks = calls.length
    assert.equal((await send(baseline, { name: 'stale' })).statusCode, 409)
    assert.equal(snapshot(), before); assert.equal(events, count); assert.equal(calls.length, hooks)
    cfg.updateObject(device.id, original)
  }
  assert.equal(JSON.stringify([cfg.listGroups(device.id), cfg.listRegistersByObject(device.id), cfg.listRules()]), children)

  before = snapshot(); count = events; hooks = calls.length
  for (const bad of [null, {}, [], { id: device.id }, { isActive: 1 }, { dataRetainSeconds: 0 }, { name: ' ' }, { port: '502' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { mode: 'invalid' }, { transport: 'bad' }, { ip: '' }, { baudRate: NaN }, { baudRate: Infinity }, { baudRate: 0 }, { parity: 'bad' }, { flowControl: 'bad' }, { dataBits: 9 }, { stopBits: 0 }, { slaveId: -1 }, { slaveId: 248 }, { slaveId: 0.5 }, { pollIntervalMs: 0 }, { timeoutMs: 2147483648 }, { serialPath: {} }]) {
    assert.throws(() => cfg.updateObjectSettings(device.id, { expected: capture(), changes: bad }), error => (error as any).statusCode === 400)
    assert.equal(snapshot(), before); assert.equal(events, count); assert.equal(calls.length, hooks)
  }
  for (const expected of [null, {}, { ...capture(), id: 999 }, { ...capture(), baudRate: '9600' }]) assert.equal((await send(expected, { name: 'bad' })).statusCode, 400)
  assert.equal((await send(capture(), { name: 'bad' }, '/api/monitor_objects/1junk/settings')).statusCode, 400)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/monitor_objects/' + device.id + '/settings', payload: fields() })).statusCode, 400)
  // Existing slave validation still applies; hostnames remain legal for TCP masters.
  assert.equal((await send(capture(), { mode: 'slave', ip: 'not-an-ip' })).statusCode, 400)
  assert.equal((await send(capture(), { mode: 'slave', ip: '127.0.0.1', slaveId: 0 })).statusCode, 400)
  assert.equal((await send(capture(), { mode: 'slave', transport: 'rtu', serialPath: 'SYNTHETIC_ONLY', dataBits: 7 })).statusCode, 400)
  assert.equal((await send(capture(), { transport: 'rtu', serialPath: 'SYNTHETIC_ONLY', baudRate: 9600 })).statusCode, 200, 'metadata only; mock runtime does not open this path')
  assert.equal((await send(capture(), { transport: 'tcp', ip: 'master.mock.invalid', port: 65535 })).statusCode, 200)

  const mutable = JSON.parse(JSON.stringify(capture())), frozen = captureDeviceEditBaseline(mutable), text = JSON.stringify(frozen)
  mutable.ip = 'changed outside'; assert.equal(JSON.stringify(frozen), text); assert.ok(Object.isFrozen(frozen))
  assert.deepEqual(parseDeviceEditRequest(JSON.parse(JSON.stringify({ expected: frozen, changes: { name: 'new' } }))).expected, frozen)
  assert.equal(deviceEditMatches(captureDeviceEditBaseline({ ...frozen, connected: true, isActive: 0 }), frozen), true)

  const db = (cfg as any).db, prepare = db.prepare.bind(db), exec = db.exec.bind(db)
  for (const failure of ['update', 'readback', 'commit']) {
    const expected = capture(); before = snapshot(); count = events; hooks = calls.length; let updated = false
    db.prepare = (sql: string) => {
      if (sql.startsWith('UPDATE monitor_objects SET')) { if (failure === 'update') throw new Error('synthetic update failure'); updated = true }
      if (failure === 'readback' && updated && sql.startsWith('SELECT id, name, ip')) throw new Error('synthetic readback failure')
      return prepare(sql)
    }
    db.exec = (sql: string) => { if (failure === 'commit' && sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql) }
    try { const result = await send(expected, { name: 'must roll back', ip: 'rollback.mock.invalid' }); assert.equal(result.statusCode, 500); assert.match(result.json().error, /结果待核实/) }
    finally { db.prepare = prepare; db.exec = exec }
    assert.equal(snapshot(), before); assert.equal(events, count); assert.equal(calls.length, hooks)
  }
  const rollbackExpected = capture(); hooks = calls.length
  db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('synthetic transaction failure'); return exec(sql) }
  try { const result = await send(rollbackExpected, { name: 'uncertain' }); assert.equal(result.statusCode, 500); assert.match(result.json().error, /结果待核实/); assert.equal(calls.length, hooks) }
  finally { db.exec = exec; exec('ROLLBACK') }
  assert.equal(cfg.getObject(device.id)!.name, rollbackExpected.name)

  failNotify = true; failReconnect = true; failSync = true; hooks = calls.length
  const warningResult = await send(capture(), { name: 'saved despite runtime warnings' })
  failNotify = false; failReconnect = false; failSync = false
  assert.equal(warningResult.statusCode, 200); assert.equal(warningResult.json().warnings.length, 3)
  assert.equal(cfg.getObject(device.id)!.name, 'saved despite runtime warnings'); assert.deepEqual(calls.slice(hooks), ['reconnect:' + device.id, 'sync'])

  let requests = 0
  const warnings = await saveGuardedDeviceSettings(capture(), { name: 'frontend actual guarded API' }, async (url, body) => { requests++; assert.ok(url.endsWith('/settings')); const result = await app.inject({ method: 'PUT', url, payload: body as any }); assert.equal(result.statusCode, 200); return result.json() })
  assert.equal(requests, 1); assert.deepEqual(warnings, [])
  const shownWarnings = await saveGuardedDeviceSettings(capture(), { name: 'saved with warning' }, async () => ({ device: { ...cfg.getObject(device.id), name: 'saved with warning' }, warnings: ['synthetic runtime warning'] }))
  assert.deepEqual(shownWarnings, ['synthetic runtime warning']); assert.ok(Object.isFrozen(shownWarnings))
  await assert.rejects(saveGuardedDeviceSettings(capture(), { name: 'x' }, async () => { requests++; throw new Error('HTTP 404 old server') }), /HTTP 404/)
  assert.equal(requests, 2, 'no fallback or retry')
  for (const result of [null, {}, { device: cfg.getObject(device.id), warnings: 'bad' }, { device: { ...cfg.getObject(device.id), id: 999 }, warnings: [] }, { device: cfg.getObject(device.id), warnings: [] }]) await assert.rejects(saveGuardedDeviceSettings(capture(), { name: 'not yet saved' }, async () => result), /结果待核实/)
  const deleted = capture(); cfg.deleteObject(device.id); hooks = calls.length
  assert.equal((await send(deleted, { name: 'deleted' })).statusCode, 404); assert.equal(calls.length, hooks)
} finally { await app.close(); (cfg as any).db.close() }

// Another connection cannot race between compare and write; only a newly created isolated file is opened.
const scratchParent = resolve(tmpdir()), scratch = mkdtempSync(join(scratchParent, 'probe-device-edit-'))
assert.equal(dirname(resolve(scratch)), scratchParent); assert.ok(basename(scratch).startsWith('probe-device-edit-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  a = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); b = new ConfigStore({ dbPath: join(scratch, 'isolated.db') })
  const d = a.createObject('two-connection synthetic', 'mock.invalid', 502), expected = captureDeviceEditBaseline(d), db = (a as any).db, prepare = db.prepare.bind(db)
  let blocked = 0
  db.prepare = (sql: string) => { if (sql.startsWith('UPDATE monitor_objects SET')) { assert.throws(() => b!.updateObject(d.id, { ip: 'racing.mock.invalid' }), /locked|busy/i); blocked++ }; return prepare(sql) }
  a.updateObjectSettings(d.id, { expected, changes: { name: 'guarded' } }); db.prepare = prepare
  assert.equal(blocked, 1); assert.equal(b.getObject(d.id)!.name, 'guarded')
  b.updateObject(d.id, { ip: 'later.mock.invalid' })
  assert.throws(() => a!.updateObjectSettings(d.id, { expected, changes: { name: 'stale' } }), error => (error as any).statusCode === 409)
} finally {
  if (a) (a as any).db.close(); if (b) (b as any).db.close()
  assert.equal(dirname(resolve(scratch)), scratchParent); assert.ok(basename(scratch).startsWith('probe-device-edit-')); rmSync(scratch, { recursive: true, force: true })
}
let rendersSaved = 0, portsFetched = 0
const sample = { id: 1, name: '<synthetic device>', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: null, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const render = (initial: any, english = false) => renderToStaticMarkup(createElement(DeviceModal, { initial, t: key => key === 'cancel' && english ? 'Cancel' : key, onClose() {}, async onSave() { rendersSaved++ }, portFetcher: async () => { portsFetched++; return { ports: [], source: 'mock', location: 'backend', enumerationOnly: true } } }))
assert.match(render(sample), /冲突会拒绝保存并保留草稿/); assert.match(render(sample, true), /Conflicts reject/)
assert.match(render(sample), /&lt;synthetic device&gt;/); assert.doesNotMatch(render(null), /冲突会拒绝保存/)
assert.match(render({ ...sample, transport: 'rtu', serialPath: 'SYNTHETIC_ONLY' }), /SYNTHETIC_ONLY/)
assert.match(render({ ...sample, timeoutMs: undefined }), /设备配置不完整/)
assert.equal(rendersSaved, 0); assert.equal(portsFetched, 0, 'SSR does not enumerate or open serial ports')
console.log('DEVICE EDIT CONFLICT OK: stale connection rejection, frozen editor fields, independent activation/retention, children preserved, strict request and existing slave constraints, rollback/notification and mock-runtime warnings, no fallback/readback validation, dual-connection lock and production modal SSR; memory/isolated temp only, no DOM automation or real runtime hooks')
