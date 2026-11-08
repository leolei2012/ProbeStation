import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerActivationSettings } from '../packages/api/src/activation-settings.ts'
import { captureActivation, type ActivationKind } from '../packages/core/src/activation-settings.ts'
import { ActivationUncertainError, saveActivation } from '../apps/web/src/activation-settings-save.ts'
import { readDeviceGroups } from '../apps/web/src/config-read.ts'

const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const legacyRoutes: ts.CallExpression[] = []
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && ['/api/monitor_objects/:id/toggle', '/api/groups/:id/toggle-pause'].includes(node.arguments[0].text)) legacyRoutes.push(node); ts.forEachChild(node, visit) }; visit(apiSource); assert.equal(legacyRoutes.length, 2)
const uiSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const compile = (code: string, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + code + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
const operationSource = uiSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useOperation')!.getText(uiSource)
function callback(kind: ActivationKind) {
  const name = kind === 'device' ? 'toggleDevice' : 'toggleGroupPause'; let found: ts.VariableDeclaration | undefined
  const walk = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(uiSource) === name) found = node; ts.forEachChild(node, walk) }; walk(uiSource); assert(found); return found.initializer!.getText(uiSource)
}
function fixture(newApi: boolean) {
  let events = 0, syncs = 0
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++ }), app = Fastify(), runtime = { async syncSlaves() { syncs++ } }
  for (const route of legacyRoutes) new Function('fastify', 'cfg', 'ctx', ts.transpileModule(route.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app, cfg, { get() { return { sync: runtime.syncSlaves } } })
  if (newApi) registerActivationSettings(app, cfg, runtime)
  const device = cfg.createObject('version fixture', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'version group', 3, 0, 1, 'read', 7)
  return { cfg, app, device, group, get events() { return events }, get syncs() { return syncs }, async close() { await app.close(); (cfg as any).db.close() } }
}
const snapshot = (f: ReturnType<typeof fixture>, kind: ActivationKind) => captureActivation(f.cfg.getObject(f.device.id), kind === 'group' ? f.cfg.getGroup(f.group.id) : undefined)
const url = (f: ReturnType<typeof fixture>, kind: ActivationKind) => (kind === 'device' ? '/api/monitor_objects/' + f.device.id : '/api/groups/' + f.group.id) + '/activation'
const put = (f: ReturnType<typeof fixture>, kind: ActivationKind, expected: unknown, isActive = 0) => f.app.inject({ method: 'PUT', url: url(f, kind), payload: { expected, isActive } })

// Malformed mixed snapshots must be rejected, never silently downgrade group identity to a device snapshot.
const malformed = fixture(true)
try {
  const expected = snapshot(malformed, 'group'), before = malformed.events
  for (const group of [undefined, null, [], {}]) {
    const result = await put(malformed, 'group', { device: { ...expected.device, isActive: 1 }, group, isActive: 1 })
    assert.equal(result.statusCode, 400, 'missing group identity is a rejected request, not HTTP 500 / uncertain write')
  }
  assert.equal(malformed.events, before); assert.equal(malformed.cfg.getGroup(malformed.group.id)!.isActive, 1)
  const validLegacyShape = { ...expected, device: { ...expected.device, isActive: 1 } }
  assert.equal((await put(malformed, 'group', validLegacyShape)).statusCode, 200, 'a valid group snapshot with a full device record remains compatible')
} finally { await malformed.close() }

for (const newApi of [false, true]) {
  // Old client contract works against old/new route sets; it retains its unsafe inverse semantics.
  const oldClient = fixture(newApi)
  try {
    for (const kind of ['device', 'group'] as const) {
      const path = kind === 'device' ? '/api/monitor_objects/' + oldClient.device.id + '/toggle' : '/api/groups/' + oldClient.group.id + '/toggle-pause'
      const first = await oldClient.app.inject({ method: 'POST', url: path }); assert.equal(first.statusCode, 200); assert.equal(first.json().isActive, 0); assert.equal(first.json().snapshot, undefined)
      const repeat = await oldClient.app.inject({ method: 'POST', url: path }); assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().isActive, 1)
    }
  } finally { await oldClient.close() }
  // Current production App callbacks and operation hook use one PUT and never fall back on an old server.
  const currentClient = fixture(newApi)
  try {
    for (const kind of ['device', 'group'] as const) {
      const notices: any[] = [], calls: string[] = []; let refreshes = 0
      const operation = compile(operationSource, { useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }), showOperationNotice: (value: any) => notices.push(value), ActivationUncertainError })((key: string) => key)
      const request = async (method: 'POST' | 'PUT', path: string, body: any) => { calls.push(method); const response = await currentClient.app.inject({ method, url: path, payload: body }); if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body); return response.json() }
      const groups = await readDeviceGroups(currentClient.device.id, new AbortController().signal, async path => path.endsWith('/groups') ? currentClient.cfg.listGroups(currentClient.device.id) : [])
      const env = { api: { post: (path: string, body: any) => request('POST', path, body), put: (path: string, body: any) => request('PUT', path, body) }, operation, devices: [currentClient.device], device: currentClient.device, groups, captureActivation, saveActivation, refreshDevices() { refreshes++ }, onRefresh() { refreshes++ }, t: (key: string) => key }
      const events = currentClient.events, syncs = currentClient.syncs
      await compile(callback(kind), env)(kind === 'device' ? currentClient.device.id : currentClient.group.id)
      assert.deepEqual(calls, ['PUT']); assert.equal(refreshes, newApi ? 1 : 0); assert.equal(snapshot(currentClient, kind).isActive, newApi ? 0 : 1)
      assert.equal(currentClient.events, events + (newApi ? 1 : 0)); assert.equal(currentClient.syncs, syncs + (newApi && kind === 'device' ? 1 : 0))
      if (!newApi) { assert.equal(notices.at(-1).error, true); assert.match(notices.at(-1).text, /HTTP 404/) }
      else assert.equal(notices.at(-1).error, false)
    }
  } finally { await currentClient.close() }
}

for (const kind of ['device', 'group'] as const) {
  const f = fixture(true)
  try {
    const original = snapshot(f, kind)
    assert.equal((await put(f, kind, original)).statusCode, 200)
    assert.equal((await put(f, kind, original)).statusCode, 409, 'immediate duplicate remains protected')
    assert.equal((await put(f, kind, snapshot(f, kind), 1)).statusCode, 200)
    const events = f.events, hooks = f.syncs
    assert.equal((await put(f, kind, original)).statusCode, 200, 'exact state ABA admits the old value condition')
    assert.equal(snapshot(f, kind).isActive, 0); assert.equal(f.events, events + 1); assert.equal(f.syncs, hooks + (kind === 'device' ? 1 : 0))
  } finally { await f.close() }
  // Normal deletion does not reuse AUTOINCREMENT IDs in this database.
  const deleted = fixture(true)
  try {
    const original = snapshot(deleted, kind), oldId = kind === 'device' ? deleted.device.id : deleted.group.id
    if (kind === 'device') { deleted.cfg.deleteObject(oldId); const replacement = deleted.cfg.createObject(deleted.device.name, deleted.device.ip, deleted.device.port); assert(replacement.id > oldId); assert.equal(replacement.isActive, 1) }
    else { deleted.cfg.deleteGroup(oldId); const replacement = deleted.cfg.createGroup(deleted.device.id, deleted.group.name, 3, 0, 1, 'read', 7); assert(replacement.id > oldId); assert.equal(replacement.isActive, 1) }
    const events = deleted.events
    assert.equal((await put(deleted, kind, original)).statusCode, 404); assert.equal(deleted.events, events)
    assert.equal((kind === 'device' ? deleted.cfg.listObjects() : deleted.cfg.listGroups(deleted.device.id))[0].isActive, 1)
  } finally { await deleted.close() }
  // Backup restore is additive: it maps source IDs to new IDs, rather than replacing the original rows.
  const restored = fixture(true)
  try {
    const original = snapshot(restored, kind), oldDevice = JSON.stringify(restored.cfg.getObject(restored.device.id)), oldGroup = JSON.stringify(restored.cfg.getGroup(restored.group.id))
    const result = restored.cfg.restoreBackup(restored.cfg.exportBackup()), cloneId = result.deviceIds[0]
    assert(cloneId > restored.device.id); assert.equal(JSON.stringify(restored.cfg.getObject(restored.device.id)), oldDevice); assert.equal(JSON.stringify(restored.cfg.getGroup(restored.group.id)), oldGroup)
    const clone = () => JSON.stringify([restored.cfg.getObject(cloneId), restored.cfg.listGroups(cloneId)]), beforeClone = clone()
    assert.equal((await put(restored, kind, original)).statusCode, 200, 'the unchanged original row retains its identity across additive restore')
    assert.equal(clone(), beforeClone, 'old requests must not target the appended clone')
  } finally { await restored.close() }
  // Same ConfigStore / API handlers, but a newly opened memory database with identical fixture values and IDs.
  const reopened = fixture(true)
  try {
    const original = snapshot(reopened, kind)
    reopened.cfg.reopen(':memory:')
    const d = reopened.cfg.createObject(reopened.device.name, reopened.device.ip, reopened.device.port)
    const g = reopened.cfg.createGroup(d.id, reopened.group.name, 3, 0, 1, 'read', 7)
    assert.equal(d.id, reopened.device.id); assert.equal(g.id, reopened.group.id); assert.deepEqual(snapshot(reopened, kind), original)
    assert.equal((await put(reopened, kind, original)).statusCode, 200, 'reopening a configuration does not invalidate value-only activation snapshots')
    assert.equal(snapshot(reopened, kind).isActive, 0)
  } finally { await reopened.close() }
  // A separate configuration instance can contain the same ID and serialized fields.
  const a = fixture(true), b = fixture(true)
  try {
    const original = snapshot(a, kind); assert.deepEqual(snapshot(b, kind), original)
    const events = b.events
    assert.equal((await put(b, kind, original)).statusCode, 200, 'a snapshot carries no database incarnation identity')
    assert.equal(snapshot(a, kind).isActive, 1); assert.equal(snapshot(b, kind).isActive, 0); assert.equal(b.events, events + 1)
    assert.equal((await put(b, kind, snapshot(b, kind), 1)).statusCode, 200)
    const stale = snapshot(a, kind); b.cfg.updateObject(b.device.id, { ip: 'different.mock.invalid' }); const beforeSourceCheck = b.events
    assert.equal((await put(b, kind, stale)).statusCode, 409, 'different source fields reject despite a reused ID and matching active state')
    assert.equal(snapshot(b, kind).isActive, 1); assert.equal(b.events, beforeSourceCheck)
  } finally { await a.close(); await b.close() }
}
console.log('ACTIVATION COMPAT OK: real legacy/new route matrix with actual current App callbacks, old server rejects one PUT/no fallback/no mutation, old client remains inverse; immediate duplicate 409 versus actual ABA 200/hooks; delete/recreate IDs advance/old path 404, additive restore preserves original IDs and cloned rows; same-store reopen and separate-store identical IDs/fields accepted versus changed source 409; malformed group identity 400; memory-only, no service/network/hardware/DOM')
