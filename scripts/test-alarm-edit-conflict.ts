import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerAlarmSettings } from '../packages/api/src/alarm-settings.ts'
import { alarmRuleMatches, captureAlarmRule, parseAlarmEdit } from '../packages/core/src/alarm-settings-edit.ts'
import { AlarmWriteGate, writeGuardedAlarm, createAlarm, completeAlarmWrite } from '../apps/web/src/alarm-settings-save.ts'
import { AlarmRuleWriteStatus } from '../apps/web/src/AlarmRuleWriteStatus.tsx'

let notifications = 0, failNotify = false
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { notifications++; if (failNotify) throw new Error('PRIVATE synthetic notification failure') }), api = Fastify()
registerAlarmSettings(api, cfg)
const d = cfg.createObject('mock alarm editing', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'mock', 3, 0, 1)
const p = cfg.createRegister(g.id, d.id, 'mock point', 3, 0), p2 = cfg.createRegister(g.id, d.id, 'same address', 3, 0)
const target = cfg.createRule(p.id, '>', 100, null), other = cfg.createRule(p2.id, '<', 5, 'other')
const current = () => captureAlarmRule(cfg.listRules().find(row => row.id === target.id))
const state = () => JSON.stringify([cfg.listRules(), cfg.listRegisters(g.id), cfg.listGroups(d.id), cfg.getObject(d.id)])
const status = (code: number) => (error: any) => error?.statusCode === code
const send = async (url: string, method: string, body: unknown) => { const r = await api.inject({ method: method as 'PUT', url, payload: body }); if (r.statusCode !== 200) throw Object.assign(new Error(r.json().error), { statusCode: r.statusCode }); return r.json() }
try {
  // Failed against the old unconditional update: 200 was silently overwritten by 150.
  const opened = current(); cfg.updateRule(target.id, { ...target, threshold: 200 })
  let snapshot = state(), n = notifications
  assert.throws(() => cfg.updateRuleSettings(target.id, { expected: opened, changes: { threshold: 150 } }), status(409))
  assert.throws(() => cfg.deleteRuleSettings(target.id, { expected: opened }), status(409)); assert.equal(state(), snapshot); assert.equal(notifications, n)
  for (const change of [{ operator: '<=' }, { threshold: -1.25 }, { message: '' }, { registerId: p2.id }]) {
    const before = current(); cfg.updateRule(target.id, { ...before, ...change }); snapshot = state(); n = notifications
    for (const method of ['PUT', 'DELETE']) {
      const r = await api.inject({ method: method as 'PUT', url: '/api/rules/' + target.id + '/settings', payload: { expected: before, ...(method === 'PUT' ? { changes: { threshold: 999 } } : {}) } })
      assert.equal(r.statusCode, 409); assert.equal(state(), snapshot); assert.equal(notifications, n)
    }
  }
  let before = current(); const saved = await writeGuardedAlarm(before, { threshold: 0, message: null }, send)
  assert.deepEqual(saved, []); assert.equal(current().threshold, 0); assert.equal(current().message, null); assert.deepEqual(cfg.listRules().find(r => r.id === other.id), other)
  assert.equal(alarmRuleMatches(before, current()), false)
  const mutable = { ...current() }, frozen = captureAlarmRule(mutable); mutable.threshold = 123
  assert.equal(frozen.threshold, 0); assert(Object.isFrozen(frozen)); assert.deepEqual(parseAlarmEdit(JSON.parse(JSON.stringify({ expected: frozen, changes: { message: '' } }))).expected, frozen)
  snapshot = state(); n = notifications
  for (const changes of [undefined, null, {}, [], { registerId: p.id }, { threshold: '1' }, { threshold: NaN }, { threshold: Infinity }, { operator: '?' }, { message: undefined }, { message: 3 }, { message: 'x'.repeat(201) }, { extra: 1 }]) {
    assert.throws(() => cfg.updateRuleSettings(target.id, { expected: current(), changes }), status(400)); assert.equal(state(), snapshot); assert.equal(notifications, n)
  }
  for (const expected of [null, {}, { ...current(), id: 0 }, { ...current(), registerId: '1' }, { ...current(), operator: '?' }, { ...current(), threshold: '0' }, { ...current(), message: false }]) assert.throws(() => cfg.deleteRuleSettings(target.id, { expected }), status(400))
  for (const raw of ['0', '01', '1junk', '9007199254740992']) assert.equal((await api.inject({ method: 'PUT', url: '/api/rules/' + raw + '/settings', payload: { expected: current(), changes: { threshold: 1 } } })).statusCode, 400)
  assert.equal((await api.inject({ method: 'DELETE', url: '/api/rules/' + target.id + '/settings', payload: {} })).statusCode, 400)
  assert.throws(() => cfg.deleteRuleSettings(other.id, { expected: current() }), status(400))
  const db = (cfg as any).db, exec = db.exec.bind(db), prepare = db.prepare.bind(db)
  for (const failure of ['update', 'commit', 'delete']) {
    snapshot = state(); n = notifications; before = current()
    db.prepare = (sql: string) => { if (failure === 'update' && sql.startsWith('UPDATE alarm_rules') || failure === 'delete' && sql.startsWith('DELETE FROM alarm_rules')) throw new Error('PRIVATE synthetic write failure'); return prepare(sql) }
    db.exec = (sql: string) => { if (failure === 'commit' && sql === 'COMMIT') throw new Error('PRIVATE synthetic commit failure'); return exec(sql) }
    const r = await api.inject({ method: failure === 'delete' ? 'DELETE' : 'PUT', url: '/api/rules/' + target.id + '/settings', payload: { expected: before, ...(failure === 'delete' ? {} : { changes: { threshold: 10 } }) } })
    db.prepare = prepare; db.exec = exec
    assert.equal(r.statusCode, 500); assert(!r.body.includes('PRIVATE')); assert.equal(state(), snapshot); assert.equal(notifications, n)
  }
  exec('CREATE TRIGGER mock_alarm AFTER UPDATE ON alarm_rules BEGIN UPDATE alarm_rules SET threshold=777 WHERE id=NEW.id; END')
  snapshot = state(); assert.throws(() => cfg.updateRuleSettings(target.id, { expected: current(), changes: { threshold: 8 } }), /读回不一致/); assert.equal(state(), snapshot); exec('DROP TRIGGER mock_alarm')
  failNotify = true
  const warned = await writeGuardedAlarm(current(), { message: '' }, send); assert.equal(warned.length, 1); assert(!warned.join().includes('PRIVATE')); assert.equal(current().message, ''); failNotify = false
  let calls = 0
  await assert.rejects(writeGuardedAlarm(current(), { threshold: 3 }, async () => { calls++; throw Object.assign(new Error('unsupported'), { statusCode: 404 }) })); assert.equal(calls, 1, 'no retry or legacy fallback')
  for (const result of [null, {}, { rule: current(), deletedRuleId: null, warnings: 'bad' }, { rule: { ...current(), threshold: 999 }, deletedRuleId: null, warnings: [] }]) await assert.rejects(writeGuardedAlarm(current(), { threshold: 2 }, async () => result), /待核实/)
  for (const result of [null, { rule: current(), deletedRuleId: target.id, warnings: [] }, { rule: null, deletedRuleId: other.id, warnings: [] }]) await assert.rejects(writeGuardedAlarm(current(), null, async () => result), /待核实/)
  before = current(); await writeGuardedAlarm(before, null, send)
  assert.equal(cfg.listRules().some(r => r.id === target.id), false); assert(cfg.getRegister(p.id)); assert.deepEqual(cfg.listRules(), [other])
  await assert.rejects(writeGuardedAlarm(before, null, send), status(404))
} finally { await api.close(); (cfg as any).db.close() }

const scratchParent = resolve(tmpdir()), scratch = mkdtempSync(join(scratchParent, 'probe-alarm-edit-'))
assert.equal(dirname(resolve(scratch)), scratchParent); assert(basename(scratch).startsWith('probe-alarm-edit-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  a = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); b = new ConfigStore({ dbPath: join(scratch, 'isolated.db') })
  const d = a.createObject('two-connection mock', 'mock.invalid', 502), g = a.createGroup(d.id, 'mock', 3, 0, 1), p = a.createRegister(g.id, d.id, 'mock', 3, 0), r = a.createRule(p.id, '>', 1, null)
  const db = (a as any).db, prepare = db.prepare.bind(db); let locked = 0
  db.prepare = (sql: string) => { if (sql.startsWith('UPDATE alarm_rules')) { assert.throws(() => b!.updateRule(r.id, { ...r, threshold: 2 }), /locked|busy/i); locked++ }; return prepare(sql) }
  a.updateRuleSettings(r.id, { expected: r, changes: { threshold: 3 } }); db.prepare = prepare
  assert.equal(locked, 1); assert.equal(b.listRules()[0].threshold, 3)
  b.updateRule(r.id, { ...r, threshold: 4 }); assert.throws(() => a!.deleteRuleSettings(r.id, { expected: r }), status(409)); assert.equal(a.listRules()[0].threshold, 4)
} finally {
  if (a) (a as any).db.close(); if (b) (b as any).db.close()
  assert.equal(dirname(resolve(scratch)), scratchParent); assert(basename(scratch).startsWith('probe-alarm-edit-')); rmSync(scratch, { recursive: true, force: true })
}
const gate = new AlarmWriteGate(); let writes = 0, release!: () => void
const fields = { registerId: 1, operator: '>', threshold: 0, message: null }
let creates = 0
assert.deepEqual(await createAlarm(fields, async (url, method, body) => { creates++; assert.equal(url, '/api/rules'); assert.equal(method, 'POST'); assert.deepEqual(body, fields); return { id: 123, ...fields } }), [])
assert.equal(creates, 1)
for (const result of [null, {}, { id: 123, ...fields, threshold: 9 }, { id: 123, ...fields, registerId: 2 }]) {
  gate.reset(); assert.equal(await gate.run(async () => { await createAlarm(fields, async () => result) }), false); assert.equal(gate.snapshot().reason, 'uncertain')
}
gate.reset()
let readbacks = 0
const completed = await completeAlarmWrite(async () => ['saved warning'], async () => { readbacks++; return [{ id: 123, ...fields }] }, new AbortController().signal)
assert.equal(completed.rules[0].id, 123); assert.deepEqual(completed.warnings, ['saved warning'])
assert.equal(await gate.run(async signal => { await completeAlarmWrite(async () => [], async () => { readbacks++; throw Object.assign(new Error('read failed'), { statusCode: 409 }) }, signal) }), false)
assert.equal(gate.snapshot().reason, 'uncertain', 'post-write HTTP409 is not a rejected write')
gate.reset(); const readBefore = readbacks
assert.equal(await gate.run(async signal => { await completeAlarmWrite(async () => { throw Object.assign(new Error('write conflict'), { statusCode: 409 }) }, async () => { readbacks++; return [] }, signal) }), false)
assert.equal(gate.snapshot().reason, 'conflict'); assert.equal(readbacks, readBefore, 'a rejected write must not fetch a misleading success readback')
gate.reset()
const pending = gate.run(async () => { writes++; await new Promise<void>(resolve => { release = resolve }) })
await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(await gate.run(async () => { writes++ }), false); release(); assert.equal(await pending, true); assert.equal(writes, 1)
assert.equal(await gate.run(async () => { writes++ }), false, 'success also requires explicit new-draft reset'); gate.reset()
assert.equal(await gate.run(async () => { throw Object.assign(new Error('<mock conflict>'), { statusCode: 409 }) }), false); assert.equal(gate.snapshot().reason, 'conflict')
assert.equal(await gate.run(async () => { writes++ }), false); assert.equal(writes, 1, 'reread cannot unblock or repeat a rejected write')
let clicks = 0
for (const english of [false, true]) { const html = renderToStaticMarkup(createElement(AlarmRuleWriteStatus, { state: gate.snapshot(), onReset: () => clicks++, english })); assert(!html.includes('<mock conflict>')); assert(html.includes('&lt;mock conflict&gt;')); assert(html.includes(english ? 'draft' : '草稿')) }
gate.reset(); let late!: () => void, aborted = false
assert.equal(await gate.run(async signal => { signal.addEventListener('abort', () => { aborted = true }); await new Promise<void>(resolve => { late = resolve }) }, 15), false)
assert.equal(gate.snapshot().reason, 'uncertain'); assert(aborted); late(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(gate.snapshot().phase, 'blocked', 'late success cannot clear uncertainty')
assert.equal(clicks, 0)
console.log('ALARM EDIT CONFLICT OK: stale edit/delete repro, frozen conditions, same-address isolation, strict API/client no-fallback, NULL/zero/empty values, rollback/readback/notification, two-connection SQLite lock, duplicate/timeout/late-write blocking and bilingual escaped SSR; memory/temp/mock only, no DOM or hardware')
