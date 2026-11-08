import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerGroupSettings } from '../packages/api/src/group-settings.ts'
import { captureGroupOpening, parseGroupEditSnapshot, acceptGroupEditSnapshot, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { fullGroupForEditing, readGroupSettings, saveGuardedGroupSettings } from '../apps/web/src/group-settings-save.ts'
import { GroupModal } from '../apps/web/src/GroupModal.tsx'
import { stageMemoryConfigurationRecovery } from './fixtures/config-recovery-driver.ts'
let recovery: ReturnType<typeof stageMemoryConfigurationRecovery> | undefined


let observe = false, failNotify = false
const events: string[] = []
const cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => { if (observe) events.push(scope + ':' + id); if (failNotify) throw new Error('synthetic notify failure') }), api = Fastify()
registerGroupSettings(api, cfg)
const d = cfg.createObject('synthetic group editor', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'target', 3, 0, 1), first = cfg.createRegister(g.id, d.id, 'keep', 3, 0, 'uint32', { quantity: 2, factor: 0, enumJson: ' {"01":" On "} ' })
const graph = () => JSON.stringify([cfg.listObjects(), cfg.listGroups(d.id), cfg.listRegistersByObject(d.id), cfg.listRules()])
const capture = () => cfg.getGroupSettings(g.id)
const opening = () => captureGroupOpening({ ...cfg.getGroup(g.id), registers: cfg.listRegisters(g.id) }, cfg.getObject(d.id))
const send = (snapshot: ReturnType<typeof capture>, changes: unknown, confirm = false) => {
  const plan = planGroupResize(snapshot, parseGroupEditChanges(changes, snapshot.group))
  return api.inject({ method: 'PUT', url: '/api/groups/' + g.id + '/settings', payload: { expectedRevision: snapshot.revision, changes, ...(confirm ? { confirmedDeletion: { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } } : {}) } })
}
try {
  // Legacy compatibility path is now atomic: same original expansion code, one complete notification.
  observe = true
  const create = cfg.createRegister.bind(cfg), originalDelete = cfg.deleteRegister.bind(cfg), db = (cfg as any).db, exec = db.exec.bind(db)
  let before = graph(), count = events.length, attempts = 0
  cfg.createRegister = ((...args: Parameters<typeof create>) => { if (++attempts === 2) throw new Error('synthetic second insertion'); return create(...args) })
  try { assert.throws(() => cfg.updateGroup(g.id, { quantity: 4 }), /synthetic/); assert.equal(graph(), before); assert.equal(events.length, count) } finally { cfg.createRegister = create }
  cfg.updateGroup(g.id, { quantity: 4 }); assert.equal(events.length, count + 1); assert.equal(events.at(-1), 'group:' + g.id)
  const tail = cfg.listRegisters(g.id).slice(1)
  for (const point of tail) cfg.createRule(point.id, '>', 12, 'synthetic alarm ' + point.id)
  before = graph(); count = events.length; attempts = 0
  cfg.deleteRegister = ((id: number) => { originalDelete(id); if (++attempts === 2) throw new Error('synthetic after second deletion') })
  try { assert.throws(() => cfg.updateGroup(g.id, { quantity: 1 }), /synthetic/); assert.equal(graph(), before); assert.equal(events.length, count) } finally { cfg.deleteRegister = originalDelete }
  const oldSnapshot = capture(); count = events.length
  assert.deepEqual(capture(), oldSnapshot); assert.equal(events.length, count, 'coherent reads publish no changes')
  const complete = { ...cfg.getGroup(g.id)!, registers: cfg.listRegisters(g.id) }, visible = { ...complete, registers: [complete.registers[0]] }
  assert.throws(() => acceptGroupEditSnapshot(capture(), captureGroupOpening(visible, cfg.getObject(d.id))), /未加载新的保存条件/)
  assert.equal(acceptGroupEditSnapshot(capture(), captureGroupOpening(fullGroupForEditing([complete], visible.id), cfg.getObject(d.id))).registers.length, complete.registers.length, 'editing from a filtered view still captures every configured point')
  assert.throws(() => fullGroupForEditing([complete], 999), /完整点表中未找到/)

  // Concurrent additions, metadata, alarm and device-source changes all invalidate the old graph.
  const mutations = [
    () => { const p = cfg.createRegister(g.id, d.id, 'concurrent new', 3, 8, 'uint16'); cfg.createRule(p.id, '<', 0, 'new alarm') },
    () => cfg.updateRegister(first.id, { unit: 'concurrent metadata' }),
    () => cfg.updateRule(cfg.listRules()[0].id, { registerId: tail[0].id, operator: '>', threshold: 99, message: 'changed alarm' }),
    () => cfg.createRule(first.id, '>', 44, 'added alarm'),
    () => cfg.updateGroup(g.id, { name: 'concurrent rename' }),
    () => cfg.updateObject(d.id, { ip: 'other.mock.invalid' }),
  ]
  for (const mutate of mutations) {
    const snapshot = capture(); mutate(); before = graph(); count = events.length
    const rejected = await send(snapshot, { quantity: 1 }, true)
    assert.equal(rejected.statusCode, 409); assert.match(rejected.json().error, /草稿已保留/); assert.equal(graph(), before); assert.equal(events.length, count)
  }
  let snapshot = capture(), plan = planGroupResize(snapshot, { quantity: 1 })
  assert.ok(plan.removeRegisterIds.length > 0 && plan.removeRuleIds.length > 0)
  before = graph(); count = events.length
  assert.equal((await send(snapshot, { quantity: 1 })).statusCode, 400)
  assert.equal((await api.inject({ method: 'PUT', url: '/api/groups/' + g.id + '/settings', payload: { expectedRevision: snapshot.revision, changes: { quantity: 1 }, confirmedDeletion: { registerIds: [...plan.removeRegisterIds].reverse(), ruleIds: plan.removeRuleIds } } })).statusCode, 400)
  assert.equal(graph(), before); assert.equal(events.length, count)
  const result = await send(snapshot, { quantity: 1 }, true)
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json().deletedRegisterIds, plan.removeRegisterIds); assert.deepEqual(result.json().deletedRuleIds, plan.removeRuleIds)
  assert.deepEqual(cfg.listRegisters(g.id).map(row => row.id), [first.id]); assert.equal(cfg.listRules().length, 1)
  assert.equal(cfg.getRegister(first.id)!.dataType, 'uint32'); assert.equal(cfg.getRegister(first.id)!.quantity, 2); assert.equal(cfg.getRegister(first.id)!.factor, 0)
  assert.equal((await send(snapshot, { quantity: 1 }, true)).statusCode, 409, 'a consumed changed graph cannot silently replay a destructive edit')

  // Fresh graph must not silently become the expected version for an old table/draft.
  const opened = opening(); cfg.updateRegister(first.id, { alias: 'later alias' })
  assert.throws(() => acceptGroupEditSnapshot(capture(), opened), /未加载新的保存条件/)
  const loaded = await readGroupSettings(opening(), async url => { const response = await api.inject({ method: 'GET', url }); assert.equal(response.statusCode, 200); return response.json() }, new AbortController().signal)
  assert.equal(loaded.revision, capture().revision)
  await assert.rejects(readGroupSettings(opening(), async () => new Promise(() => {}), new AbortController().signal, 2), /超时/)
  const abort = new AbortController(), pending = readGroupSettings(opening(), async () => new Promise(() => {}), abort.signal); abort.abort(); await assert.rejects(pending)
  await assert.rejects(readGroupSettings(opening(), async () => { throw new Error('synthetic read failure') }, new AbortController().signal), /synthetic/)
  assert.equal((await readGroupSettings(opening(), async () => capture(), new AbortController().signal)).revision, capture().revision)
  const other = cfg.createGroup(d.id, 'other slave', 3, 0, 2, 'read', 11), otherPoint = cfg.createRegister(other.id, d.id, 'same address', 3, 0, 'uint16')
  const unrelated = capture(); cfg.updateRegister(otherPoint.id, { alias: 'other edit' }); cfg.createRule(otherPoint.id, '>', 1, 'other alarm')
  assert.equal(capture().revision, unrelated.revision, 'other group/slave changes do not invalidate this graph')
  assert.equal((await send(unrelated, { name: 'target only' })).statusCode, 200)
  assert.equal(cfg.getRegister(otherPoint.id)!.alias, 'other edit')

  // Preserve existing definition-count / FC/address rules, including duplicate addresses.
  const dup = cfg.createRegister(g.id, d.id, 'duplicate address', 3, 0, 'uint64')
  snapshot = capture(); plan = planGroupResize(snapshot, { quantity: 3 })
  assert.deepEqual(plan.addAddresses, [1, 2]); assert.equal(plan.removeRegisterIds.length, 0)
  const grown = await send(snapshot, { quantity: 3, functionCode: 4, startAddress: 0 })
  assert.equal(grown.statusCode, 200); assert.equal(cfg.listRegisters(g.id).length, 4, 'legacy duplicate-address expansion counts unique existing addresses')
  assert.equal(cfg.getRegister(first.id)!.functionCode, 3); assert.equal(cfg.getRegister(dup.id)!.functionCode, 3)
  assert.ok(cfg.listRegisters(g.id).filter(row => row.id !== first.id && row.id !== dup.id).every(row => row.functionCode === 4 && row.dataType === 'int16' && row.alias === null))
  const unchangedQty = cfg.listRegisters(g.id).map(row => row.id), noResize = await send(capture(), { startAddress: 20, functionCode: 3, quantity: 3 })
  assert.equal(noResize.statusCode, 200); assert.deepEqual(cfg.listRegisters(g.id).map(row => row.id), unchangedQty)
  assert.deepEqual(cfg.listRegisters(g.id).map(row => row.startAddress), [0, 0, 1, 2], 'range/function changes do not readdress existing definitions')

  before = graph(); count = events.length
  for (const bad of [null, {}, [], { id: 1 }, { objectId: 999 }, { mode: 'write' }, { name: ' ' }, { slaveId: '1' }, { slaveId: 248 }, { functionCode: 6 }, { startAddress: -1 }, { startAddress: 65536 }, { quantity: 0 }, { quantity: 1.5 }, { quantity: Infinity }, { quantity: 65537 }, { isActive: 2 }]) {
    assert.throws(() => cfg.updateGroupSettings(g.id, { expectedRevision: capture().revision, changes: bad }), error => (error as any).statusCode === 400)
    assert.equal(graph(), before); assert.equal(events.length, count)
  }
  for (const bad of [null, {}, { expectedRevision: 'bad', changes: { name: 'x' } }, { expectedRevision: capture().revision, changes: { name: 'x' }, extra: true }]) assert.equal((await api.inject({ method: 'PUT', url: '/api/groups/' + g.id + '/settings', payload: bad as any })).statusCode, 400)
  assert.equal((await api.inject({ method: 'GET', url: '/api/groups/1junk/settings' })).statusCode, 400)

  // Fail after existing rows/rules are deleted, after additions, during readback and at commit.
  for (const failure of ['delete', 'insert', 'readback', 'commit']) {
    const baseline = capture(), changes = failure === 'delete' ? { quantity: 1 } : { quantity: 8 }, resize = planGroupResize(baseline, changes)
    before = graph(); count = events.length; attempts = 0
    const snapshotMethod = (cfg as any).groupEditSnapshot.bind(cfg)
    if (failure === 'delete') cfg.deleteRegister = ((id: number) => { originalDelete(id); throw new Error('synthetic deletion failure') })
    if (failure === 'insert') cfg.createRegister = ((...args: Parameters<typeof create>) => { const row = create(...args); if (++attempts === 2) throw new Error('synthetic insertion failure'); return row })
    if (failure === 'readback') (cfg as any).groupEditSnapshot = (id: number) => { if (++attempts === 2) throw new Error('synthetic readback failure'); return snapshotMethod(id) }
    db.exec = (sql: string) => { if (failure === 'commit' && sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql) }
    try {
      const response = await api.inject({ method: 'PUT', url: '/api/groups/' + g.id + '/settings', payload: { expectedRevision: baseline.revision, changes, confirmedDeletion: { registerIds: resize.removeRegisterIds, ruleIds: resize.removeRuleIds } } })
      assert.equal(response.statusCode, 500); assert.match(response.json().error, /结果待核实/)
    } finally { cfg.deleteRegister = originalDelete; cfg.createRegister = create; (cfg as any).groupEditSnapshot = snapshotMethod; db.exec = exec }
    assert.equal(graph(), before); assert.equal(events.length, count); assert.equal(capture().revision, baseline.revision)
  }
  failNotify = true
  const warned = await send(capture(), { name: 'committed despite notification' }); failNotify = false
  assert.equal(warned.statusCode, 200); assert.equal(warned.json().warnings.length, 1); assert.equal(cfg.getGroup(g.id)!.name, 'committed despite notification')
  before = graph(); count = events.length
  const wrongDeleteSnapshot = capture(); let wrongDeleted = false
  cfg.deleteRegister = ((id: number) => { if (!wrongDeleted) { wrongDeleted = true; originalDelete(wrongDeleteSnapshot.registers[0].id) } else originalDelete(id) })
  try { const inconsistent = await send(wrongDeleteSnapshot, { quantity: 1 }, true); assert.equal(inconsistent.statusCode, 500); assert.equal(graph(), before); assert.equal(events.length, count) }
  finally { cfg.deleteRegister = originalDelete }
  const rollbackSnapshot = capture(); before = graph(); count = events.length
  recovery = stageMemoryConfigurationRecovery(cfg)
  db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('synthetic rollback failure'); return exec(sql) }
  try { const uncertain = await send(rollbackSnapshot, { name: 'uncertain' }); assert.equal(uncertain.statusCode, 500); assert.match(uncertain.json().error, /待核实/); assert.equal(events.length, count) }
  finally { db.exec = exec; exec('ROLLBACK') }
  assert.throws(graph, /此连接已隔离/, 'manual native rollback does not lift quarantine')
  recovery.reopen()
  assert.equal(graph(), before)

  let writes = 0
  snapshot = capture()
  const saved = await saveGuardedGroupSettings(snapshot, { name: 'frontend saved' }, false, async (url, body) => { writes++; assert.ok(JSON.stringify(body).length < 1000); const response = await api.inject({ method: 'PUT', url, payload: body as any }); assert.equal(response.statusCode, 200); return response.json() })
  assert.equal(writes, 1); assert.equal(saved.deleted, 0)
  const oldEnum = cfg.getRegister(first.id)!.enumJson, hugeEnum = 'x'.repeat(1_100_000)
  cfg.updateRegister(first.id, { enumJson: hugeEnum })
  await saveGuardedGroupSettings(capture(), { name: 'large map preserved' }, false, async (url, body) => { assert.ok(JSON.stringify(body).length < 1000); const response = await api.inject({ method: 'PUT', url, payload: body as any }); assert.equal(response.statusCode, 200); return response.json() })
  assert.equal(cfg.getRegister(first.id)!.enumJson, hugeEnum); cfg.updateRegister(first.id, { enumJson: oldEnum })
  await assert.rejects(saveGuardedGroupSettings(capture(), { quantity: 1 }, false, async () => { writes++; throw new Error('must not be called') }), /确认/)
  assert.equal(writes, 1)
  await assert.rejects(saveGuardedGroupSettings(capture(), { name: 'x' }, false, async () => { writes++; throw new Error('HTTP 404 old server') }), /HTTP 404/); assert.equal(writes, 2)
  for (const invalid of [null, {}, { ...warned.json(), warnings: 'bad' }, { ...warned.json(), addedRegisterIds: [999] }]) await assert.rejects(saveGuardedGroupSettings(capture(), { name: 'not saved' }, false, async () => invalid), /待核实/)
  const lost = capture()
  await assert.rejects(saveGuardedGroupSettings(lost, { quantity: 1 }, true, async (url, body) => {
    const response = await api.inject({ method: 'PUT', url, payload: body as any }); assert.equal(response.statusCode, 200)
    throw new Error('synthetic response lost after commit')
  }), /保存结果待核实/)
  assert.equal(cfg.listRegisters(g.id).length, 1); before = graph(); count = events.length
  assert.equal((await send(lost, { quantity: 1 }, true)).statusCode, 409); assert.equal(graph(), before); assert.equal(events.length, count)
  const deleted = capture(); cfg.deleteGroup(g.id); count = events.length
  assert.equal((await send(deleted, { name: 'missing' })).statusCode, 404); assert.equal(events.length, count)
} finally { await api.close(); await cfg.close(); await recovery?.close() }

// A second connection cannot mutate points/rules between graph comparison and resizing.
const parent = resolve(tmpdir()), scratch = mkdtempSync(join(parent, 'probe-group-edit-'))
assert.equal(dirname(resolve(scratch)), parent); assert.ok(basename(scratch).startsWith('probe-group-edit-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  a = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); b = new ConfigStore({ dbPath: join(scratch, 'isolated.db') })
  const device = a.createObject('isolated lock', 'mock.invalid', 502), group = a.createGroup(device.id, 'g', 3, 0, 1), point = a.createRegister(group.id, device.id, 'p', 3, 0, 'uint16')
  const baseline = a.getGroupSettings(group.id), db = (a as any).db, prepare = db.prepare.bind(db); let blocked = 0
  let readBlocked = 0
  db.prepare = (sql: string) => { if (sql.startsWith('SELECT id, register_id AS registerId')) { assert.throws(() => b!.createRule(point.id, '>', 5, 'racing snapshot'), /locked|busy/i); readBlocked++ }; return prepare(sql) }
  assert.equal(a.getGroupSettings(group.id).revision, baseline.revision); assert.equal(readBlocked, 1); db.prepare = prepare
  db.prepare = (sql: string) => { if (sql.startsWith('UPDATE register_groups SET')) { assert.throws(() => b!.createRule(point.id, '>', 1, 'racing alarm'), /locked|busy/i); blocked++ }; return prepare(sql) }
  a.updateGroupSettings(group.id, { expectedRevision: baseline.revision, changes: { name: 'guarded' } }); db.prepare = prepare
  assert.equal(blocked, 1); assert.equal(b.getGroup(group.id)!.name, 'guarded')
  const stale = a.getGroupSettings(group.id); b.createRule(point.id, '>', 2, 'later alarm')
  assert.throws(() => a!.updateGroupSettings(group.id, { expectedRevision: stale.revision, changes: { quantity: 2 } }), error => (error as any).statusCode === 409)
  const reopenedRevision = b.getGroupSettings(group.id).revision
  ;(a as any).db.close(); a = undefined
  const c = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); try { assert.equal(c.getGroupSettings(group.id).revision, reopenedRevision) } finally { (c as any).db.close() }
} finally {
  if (a) (a as any).db.close(); if (b) (b as any).db.close()
  assert.equal(dirname(resolve(scratch)), parent); assert.ok(basename(scratch).startsWith('probe-group-edit-')); rmSync(scratch, { recursive: true, force: true })
}
const device = { id: 1, name: 'synthetic', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: null, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const initial = { id: 1, name: '<synthetic group>', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1, mode: 'read', isActive: 1, registers: [] }
let operations = 0
const html = renderToStaticMarkup(createElement(GroupModal, { t: key => key, device, initial, onClose() {}, onSaved() { operations++ }, async get() { operations++; throw new Error('SSR must not read') }, async put() { operations++; throw new Error('SSR must not write') }, async create() { operations++; throw new Error('SSR must not create') } }))
assert.match(html, /正在读取点位与告警快照/); assert.match(html, /&lt;synthetic group&gt;/); assert.match(html, /disabled=""/); assert.equal(operations, 0)
const largeOpening = captureGroupOpening({ ...initial, objectId: 1, registers: Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, objectId: 1, groupId: 1, alias: 'synthetic ' + i, functionCode: 3, startAddress: i, quantity: 1, dataType: 'uint16', unit: null, factor: 1, offset: 0, enumJson: null, decimalPlaces: null })) }, device)
const largeGraph = parseGroupEditSnapshot({ ...largeOpening, rules: [], revision: 'v1:' + '0'.repeat(64) })
assert.equal(largeGraph.registers.length, 10000); assert.ok(Object.isFrozen(largeGraph.registers) && Object.isFrozen(largeGraph.registers[9999]))
assert.equal(planGroupResize({ ...largeGraph, group: { ...largeGraph.group, quantity: 10000 } }, { quantity: 1 }).removeRegisterIds.length, 9999)
assert.throws(() => parseGroupEditSnapshot({ ...largeGraph, revision: 'invalid' }))
console.log('GROUP EDIT CONFLICT OK: atomic legacy resize, coherent graph/revision, stale points/rules/source rejection, explicit exact deletion acknowledgment, same-address compatibility, UI opening/read timeout/cancel/retry, guarded write verification, failures/notification warnings and two-connection lock/reopen; memory/isolated temp only, no DOM automation')
