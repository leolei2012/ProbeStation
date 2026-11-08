import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerActivationSettings } from '../packages/api/src/activation-settings.ts'
import { activationMatches, activationTarget, captureActivation, type ActivationKind } from '../packages/core/src/activation-settings.ts'
import { ActivationUncertainError, saveActivation } from '../apps/web/src/activation-settings-save.ts'
import { readDeviceGroups } from '../apps/web/src/config-read.ts'

let events = 0, failNotify = false, failSync = false, syncs = 0
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++; if (failNotify) throw Object.assign(new Error('synthetic notify failure'), { statusCode: 409 }) }), app = Fastify()
const runtime = { async syncSlaves() { syncs++; if (failSync) throw Object.assign(new Error('synthetic sync failure'), { statusCode: 400 }) } }
registerActivationSettings(app, cfg, runtime)
const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const legacy: ts.CallExpression[] = []
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && ['/api/monitor_objects/:id/toggle', '/api/groups/:id/toggle-pause'].includes(node.arguments[0].text)) legacy.push(node); ts.forEachChild(node, visit) }; visit(apiSource); assert.equal(legacy.length, 2)
for (const route of legacy) new Function('fastify', 'cfg', 'ctx', ts.transpileModule(route.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app, cfg, { get() { return { sync: runtime.syncSlaves } } })
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function variable(name: string) { let found: ts.VariableDeclaration | undefined; const walk = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node; ts.forEachChild(node, walk) }; walk(source); assert(found); return found.initializer!.getText(source) }
const compile = (text: string, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + text + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
const operationSource = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useOperation')!.getText(source)
const operation = (notices: any[]) => compile(operationSource, { useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }), showOperationNotice: (value: any) => notices.push(value), ActivationUncertainError })((key: string) => key === 'operationFailed' ? 'FAILED' : key === 'operationOk' ? 'OK' : key)
const device = cfg.createObject('synthetic activation', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic group', 3, 0, 4, 'read', 7), point = cfg.createRegister(group.id, device.id, 'keep', 3, 0, 'uint16')
cfg.createRule(point.id, '>', 42, 'keep rule')
const current = (kind: ActivationKind) => captureActivation(cfg.getObject(device.id), kind === 'group' ? cfg.getGroup(group.id) : undefined)
const id = (kind: ActivationKind) => kind === 'device' ? device.id : group.id
const path = (kind: ActivationKind) => (kind === 'device' ? '/api/monitor_objects/' : '/api/groups/') + id(kind) + '/activation'
const send = (kind: ActivationKind, expected: unknown, isActive: unknown) => app.inject({ method: 'PUT', url: path(kind), payload: { expected, isActive } })
const wire = async (url: string, body: unknown) => { const response = await app.inject({ method: 'PUT', url, payload: body as any }); if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body); return response.json() }
try {
  for (const kind of ['device', 'group'] as const) {
    const notices: any[] = [], calls: string[] = []; let lose = true, refreshed = 0
    const request = async (method: 'POST' | 'PUT', url: string, body?: unknown) => {
      calls.push(method + ' ' + url); const response = await app.inject({ method, url, payload: body as any })
      if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body)
      if (lose) { lose = false; throw new TypeError('Failed to fetch') }
      return response.json()
    }
    // Keep the UI props stale, as when the response/refresh never reaches the browser.
    const projected = await readDeviceGroups(device.id, new AbortController().signal, async url => url.endsWith('/groups') ? cfg.listGroups(device.id) : cfg.listRegisters(group.id))
    const env = { api: { post: (url: string, body: unknown) => request('POST', url, body), put: (url: string, body: unknown) => request('PUT', url, body) }, operation: operation(notices), devices: [device], device, groups: projected, refreshDevices() { refreshed++ }, onRefresh() { refreshed++ }, t: (key: string) => key === 'operationOk' ? 'OK' : key, captureActivation, saveActivation }
    const toggle = compile(variable(kind === 'device' ? 'toggleDevice' : 'toggleGroupPause'), env)
    const pending = toggle(id(kind)); await toggle(id(kind)); await pending
    assert.equal(calls.length, 1, 'the existing synchronous operation lock rejects an in-flight double click'); assert.equal(current(kind).isActive, 0)
    await toggle(id(kind)); assert.equal(current(kind).isActive, 0, 'a stale retry must never reverse the committed target')
    assert(calls.every(value => value.startsWith('PUT ') && value.endsWith('/activation')), 'no automatic legacy fallback')
    assert.equal(calls.length, 2); assert.equal(refreshed, 0)
    assert.match(notices[0].text, /结果待核实/); assert(!notices[0].text.includes('FAILED'))
    assert.match(notices[1].text, /HTTP 409/)
    if (kind === 'group') {
      await toggle(999); assert.equal(calls.length, 2, 'a missing group must never fall through to a parent-device SET')
    }
    env.devices[0] = cfg.getObject(device.id)!
    env.groups = await readDeviceGroups(device.id, new AbortController().signal, async url => url.endsWith('/groups') ? cfg.listGroups(device.id) : cfg.listRegisters(group.id))
    failNotify = true; failSync = kind === 'device'
    const freshToggle = compile(variable(kind === 'device' ? 'toggleDevice' : 'toggleGroupPause'), env)
    await freshToggle(id(kind)); failNotify = false; failSync = false
    assert.equal(current(kind).isActive, 1); assert.equal(refreshed, 1); assert.equal(notices.at(-1).error, false)
    assert.match(notices.at(-1).text, /OK.*已保存/, 'actual operation success formatter must preserve postcommit warnings')
  }
  const childGraph = JSON.stringify([cfg.listRegisters(group.id), cfg.listRules()])
  for (const kind of ['device', 'group'] as const) {
    const expected = current(kind), target = expected.isActive ? 0 : 1; let refreshed = 0
    const warnings = await saveActivation(expected, target, wire, () => { refreshed++ })
    assert.deepEqual(warnings, []); assert(Object.isFrozen(warnings)); assert.equal(refreshed, 1)
    assert(activationMatches(current(kind), activationTarget(expected, target)))
    const before = events, hooks = syncs
    assert.equal((await send(kind, expected, target)).statusCode, 409); assert.equal(events, before); assert.equal(syncs, hooks)
    assert.equal(JSON.stringify([cfg.listRegisters(group.id), cfg.listRules()]), childGraph)
    for (const value of [null, true, '0', -1, 2, 0.5]) assert.equal((await send(kind, current(kind), value)).statusCode, 400)
    assert.equal((await send(kind, current(kind), current(kind).isActive)).statusCode, 400)
    const badId = { ...current(kind), device: { ...current(kind).device, id: 999 } }
    assert.equal((await send(kind, badId, target ? 0 : 1)).statusCode, 400)
    const raceEvents = events, raceSyncs = syncs, same = current(kind), targetAgain = same.isActive ? 0 : 1
    const races = await Promise.all([send(kind, same, targetAgain), send(kind, same, targetAgain)])
    assert.deepEqual(races.map(value => value.statusCode).sort(), [200, 409]); assert.equal(events, raceEvents + 1); assert.equal(syncs, raceSyncs + (kind === 'device' ? 1 : 0))
  }
  // Source edits, activation changes and independent point edits have deliberately different preconditions.
  for (const kind of ['device', 'group'] as const) {
    let expected = current(kind); cfg.updateObject(device.id, { ip: 'other.mock.invalid' })
    assert.equal((await send(kind, expected, expected.isActive ? 0 : 1)).statusCode, 409)
    cfg.updateObject(device.id, { ip: device.ip })
    if (kind === 'group') { expected = current(kind); cfg.updateGroup(group.id, { slaveId: 8 }); assert.equal((await send(kind, expected, expected.isActive ? 0 : 1)).statusCode, 409); cfg.updateGroup(group.id, { slaveId: 7 }) }
    expected = current(kind); cfg.updateRegister(point.id, { unit: kind })
    assert.equal((await send(kind, expected, expected.isActive ? 0 : 1)).statusCode, 200, 'independent point semantics do not become an activation precondition')
  }
  failNotify = true; failSync = true
  const warnings = await saveActivation(current('device'), current('device').isActive ? 0 : 1, wire, () => { throw new Error('synthetic refresh failure') })
  assert.equal(warnings.length, 3); assert(warnings.every(value => /已保存/.test(value))); failNotify = false; failSync = false
  // Malformed success, unavailable new API and transport loss never retry or refresh to claim success.
  for (const value of [null, {}, { snapshot: current('device'), warnings: [] }, { snapshot: activationTarget(current('device'), current('device').isActive ? 0 : 1), warnings: [1] }]) {
    let calls = 0; await assert.rejects(saveActivation(current('device'), current('device').isActive ? 0 : 1, async () => { calls++; return value }, () => assert.fail('no refresh')), ActivationUncertainError); assert.equal(calls, 1)
  }
  let unsupportedCalls = 0
  await assert.rejects(saveActivation(current('device'), current('device').isActive ? 0 : 1, async () => { unsupportedCalls++; throw new Error('HTTP 404 old server') }, () => assert.fail('no refresh')), /HTTP 404/); assert.equal(unsupportedCalls, 1)
  for (const error of [new SyntaxError('synthetic JSON failure'), new Error('HTTP 500 unknown'), null]) {
    let calls = 0; await assert.rejects(saveActivation(current('device'), current('device').isActive ? 0 : 1, async () => { calls++; throw error }, () => assert.fail('no refresh')), ActivationUncertainError); assert.equal(calls, 1)
  }
  const db = (cfg as any).db, exec = db.exec.bind(db)
  for (const kind of ['device', 'group'] as const) {
    const table = kind === 'device' ? 'monitor_objects' : 'register_groups'
    for (const failure of ['update', 'readback', 'commit'] as const) {
      const expected = current(kind), before = events, hooks = syncs
      if (failure === 'update') exec(`CREATE TRIGGER fail_activation BEFORE UPDATE OF is_active ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic activation failure'); END`)
      if (failure === 'readback') exec(`CREATE TRIGGER fail_activation AFTER UPDATE OF is_active ON ${table} BEGIN UPDATE ${table} SET name = 'synthetic unexpected writeback' WHERE id = NEW.id; END`)
      if (failure === 'commit') db.exec = (sql: string) => { if (sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql) }
      try { assert.equal((await send(kind, expected, expected.isActive ? 0 : 1)).statusCode, 500) }
      finally { db.exec = exec; if (failure !== 'commit') exec('DROP TRIGGER fail_activation') }
      assert(activationMatches(current(kind), expected)); assert.equal(events, before); assert.equal(syncs, hooks)
    }
    const expected = current(kind)
    assert.equal((await send(kind, expected, expected.isActive ? 0 : 1)).statusCode, 200, 'explicit fresh SET recovers after a successful rollback')
  }
  exec('BEGIN'); db.prepare('UPDATE monitor_objects SET name = ? WHERE id = ?').run('outer pending', device.id)
  const pendingOuter = current('device')
  assert.throws(() => cfg.setActivation('device', device.id, { expected: pendingOuter, isActive: pendingOuter.isActive ? 0 : 1 }))
  assert.equal(cfg.getObject(device.id)!.name, 'outer pending'); exec('ROLLBACK')
  const rollbackExpected = current('device'), beforeRollback = events
  db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('synthetic uncertain transaction'); return exec(sql) }
  try { assert.throws(() => cfg.setActivation('device', device.id, { expected: rollbackExpected, isActive: rollbackExpected.isActive ? 0 : 1 }), AggregateError); assert.equal(events, beforeRollback) }
  finally { db.exec = exec; exec('ROLLBACK') }
  assert(activationMatches(current('device'), rollbackExpected))
  const missing = { ...current('device'), device: { ...current('device').device, id: 999 } }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/monitor_objects/999/activation', payload: { expected: missing, isActive: missing.isActive ? 0 : 1 } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/monitor_objects/1junk/activation', payload: {} })).statusCode, 400)
  for (const kind of ['device', 'group'] as const) {
    // Document the value-condition boundary: no durable operation identity or ABA generation exists.
    const original = current(kind), target = original.isActive ? 0 : 1
    assert.equal((await send(kind, original, target)).statusCode, 200)
    assert.equal((await send(kind, current(kind), original.isActive)).statusCode, 200)
    assert.equal((await send(kind, original, target)).statusCode, 200, 'an exact value ABA can accept an old request; do not claim idempotency')
    const before = current(kind).isActive
    const legacyPath = kind === 'device' ? '/api/monitor_objects/' + device.id + '/toggle' : '/api/groups/' + group.id + '/toggle-pause'
    const result = await app.inject({ method: 'POST', url: legacyPath }); assert.equal(result.statusCode, 200); assert.equal(result.json().isActive, before ? 0 : 1); assert.equal(result.json().snapshot, undefined, 'legacy response shape unchanged')
  }
} finally { await app.close(); (cfg as any).db.close() }

// Only a newly created temporary database: a second connection cannot edit source between compare and SET.
const parent = resolve(tmpdir()), scratch = mkdtempSync(join(parent, 'probe-activation-'))
assert.equal(dirname(resolve(scratch)), parent); assert(basename(scratch).startsWith('probe-activation-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  const file = join(scratch, 'isolated.db'); a = new ConfigStore({ dbPath: file }); b = new ConfigStore({ dbPath: file })
  const d = a.createObject('isolated activation', 'mock.invalid', 502), g = a.createGroup(d.id, 'isolated', 3, 0, 1)
  ;(b as any).db.exec('PRAGMA busy_timeout = 0')
  for (const kind of ['device', 'group'] as const) {
    const expected = captureActivation(a.getObject(d.id), kind === 'group' ? a.getGroup(g.id) : undefined), db = (a as any).db, prepare = db.prepare.bind(db); let locked = false
    db.prepare = (sql: string) => {
      if (sql.startsWith(kind === 'device' ? 'UPDATE monitor_objects SET is_active' : 'UPDATE register_groups SET is_active')) {
        assert.throws(() => b!.updateObject(d.id, { ip: 'concurrent.mock.invalid' }), /locked|busy/i); locked = true
      }
      return prepare(sql)
    }
    try { a.setActivation(kind, kind === 'device' ? d.id : g.id, { expected, isActive: 0 }) } finally { db.prepare = prepare }
    assert(locked); assert.equal(b.getObject(d.id)!.ip, d.ip)
    const stale = { expected, isActive: 0 }; assert.throws(() => b!.setActivation(kind, kind === 'device' ? d.id : g.id, stale), error => (error as any).statusCode === 409)
  }
  ;(a as any).db.close(); a = undefined; (b as any).db.close(); b = undefined
  a = new ConfigStore({ dbPath: file }); assert.equal(a.getObject(d.id)!.isActive, 0); assert.equal(a.getGroup(g.id)!.isActive, 0)
} finally { if (a) (a as any).db.close(); if (b) (b as any).db.close(); assert.equal(dirname(resolve(scratch)), parent); assert(basename(scratch).startsWith('probe-activation-')); rmSync(scratch, { recursive: true, force: true }) }

assert.match(apiSource.text, /registerActivationSettings\(fastify, cfg,/)
console.log('ACTIVATION SETTINGS OK: actual App callbacks/useOperation and projected groups -> explicit conditional PUT -> memory SQLite; stale retry/conflicts/concurrent duplicate cannot reverse, busy double click, missing group isolation, postcommit warnings/refresh, strict input/old-server no fallback/legacy API, trigger/readback/commit rollback and uncertain rollback, owned BEGIN, real two-connection source lock and reopen; no real service, network, DOM or hardware')
