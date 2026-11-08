import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerPointSettings } from '../packages/api/src/point-settings.ts'
import { capturePointEditBaseline, parsePointEditRequest, pointEditMatches } from '../packages/core/src/point-settings-edit.ts'
import { saveGuardedPointSettings } from '../apps/web/src/point-settings-save.ts'
import { PointSettingsEditor } from '../apps/web/src/PointSettingsEditor.tsx'
import { readDeviceGroups } from '../apps/web/src/config-read.ts'
import { PointDraftCloseGuard } from '../apps/web/src/point-draft-close.ts'
import { createPointEnumDraft } from '../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsUpdate } from '../apps/web/src/point-settings.ts'

let events = 0, failNotify = false
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++; if (failNotify) throw new Error('synthetic notification failure') }), api = Fastify()
registerPointSettings(api, cfg)
const device = cfg.createObject('synthetic conflict', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'mock', 3, 0, 4, 'read', 7), point = cfg.createRegister(group.id, device.id, 'point', 3, 0, 'uint16')
const capture = () => capturePointEditBaseline(cfg.getRegister(point.id), cfg.getGroup(group.id), cfg.getObject(device.id))
const fullFields = (expected = capture()) => ({ dataType: expected.point.dataType, unit: expected.point.unit, factor: expected.point.factor, offset: expected.point.offset, decimalPlaces: expected.point.decimalPlaces })
const send = (expected: unknown, changes: unknown, url = '/api/registers/' + point.id + '/settings') => api.inject({ method: 'PUT', url, payload: { expected, changes } })
const snapshot = () => JSON.stringify([cfg.getRegister(point.id), cfg.listGroups(device.id), cfg.getObject(device.id)])
try {
  const loaded = await readDeviceGroups(device.id, new AbortController().signal, async url => url.endsWith('/groups') ? cfg.listGroups(device.id) : cfg.listRegisters(group.id))
  assert.deepEqual(capturePointEditBaseline(loaded[0].registers[0], loaded[0], device), capture(), 'real frontend read projection must retain group mode for the frozen source guard')
  assert.throws(() => capturePointEditBaseline(point, { ...group, mode: undefined }, device), /参数无效/, 'missing source context must not be guessed')
  // The original regression: stale editor submits all scalar values, restoring an obsolete unit.
  const opened = capture(); cfg.updateRegister(point.id, { unit: 'new concurrent unit' })
  let before = snapshot(), count = events
  const stale = await send(opened, { ...fullFields(opened), factor: 2 })
  assert.equal(stale.statusCode, 409); assert.match(stale.json().error, /草稿已保留/)
  assert.equal(snapshot(), before); assert.equal(events, count); assert.equal(cfg.getRegister(point.id)!.unit, 'new concurrent unit')
  const fresh = capture(), request = { ...fullFields(fresh), factor: 2 }
  const saved = await send(fresh, request)
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().point.factor, 2); assert.deepEqual(saved.json().warnings, []); assert.equal(events, count + 1)
  assert.equal((await send(fresh, request)).statusCode, 409, 'old expected values cannot silently replay a changed write')

  // Enum omission is retained: concurrent enum changes do not block or get overwritten by scalar saves.
  const enumOpened = capture(); cfg.updateRegister(point.id, { enumJson: ' {"01":" new concurrent enum "} ' })
  const scalar = await send(enumOpened, { ...fullFields(enumOpened), offset: 12.5 })
  assert.equal(scalar.statusCode, 200); assert.equal(cfg.getRegister(point.id)!.enumJson, ' {"01":" new concurrent enum "} ')
  before = snapshot(); count = events
  assert.equal((await send(enumOpened, { enumJson: null })).statusCode, 409)
  assert.equal(snapshot(), before); assert.equal(events, count)
  const explicitEnum = capture()
  assert.equal((await send(explicitEnum, { enumJson: null })).statusCode, 200)
  assert.equal(cfg.getRegister(point.id)!.enumJson, null)

  // Independent fields may merge only when the caller really omits them. The UI currently submits all scalars.
  const independent = capture(); cfg.updateRegister(point.id, { offset: 3 })
  assert.equal((await send(independent, { unit: 'only unit' })).statusCode, 200)
  assert.equal(cfg.getRegister(point.id)!.offset, 3)
  const mismatches = [
    () => cfg.updateRegister(point.id, { alias: 'renamed point' }),
    () => cfg.updateRegister(point.id, { functionCode: 4 }),
    () => cfg.updateRegister(point.id, { startAddress: 1 }),
    () => cfg.updateRegister(point.id, { dataType: 'uint32' }),
    () => cfg.updateGroup(group.id, { slaveId: 8 }),
    () => cfg.updateGroup(group.id, { quantity: 8 }),
    () => cfg.updateGroup(group.id, { startAddress: 1 }),
    () => cfg.updateGroup(group.id, { functionCode: 4 }),
    () => cfg.updateGroup(group.id, { mode: 'write' }),
    () => cfg.updateObject(device.id, { mode: 'slave', ip: '127.0.0.1' }),
    () => cfg.updateObject(device.id, { slaveId: 9 }),
    () => cfg.updateObject(device.id, { ip: 'other.mock.invalid' }),
    () => cfg.updateObject(device.id, { serialPath: 'SYNTHETIC_ONLY' }),
    () => cfg.updateObject(device.id, { baudRate: 19200 }),
  ]
  const originalPoint = cfg.getRegister(point.id)!, originalGroup = cfg.getGroup(group.id)!, originalDevice = cfg.getObject(device.id)!
  for (const change of mismatches) {
    const expected = capture(); change(); before = snapshot(); count = events
    assert.equal((await send(expected, { unit: 'stale source' })).statusCode, 409)
    assert.equal(snapshot(), before); assert.equal(events, count)
    cfg.updateRegister(point.id, originalPoint); cfg.updateGroup(group.id, originalGroup); cfg.updateObject(device.id, originalDevice)
  }
  const unrelated = capture(); cfg.updateGroup(group.id, { name: 'new group label' }); cfg.updateObject(device.id, { name: 'new device label', isActive: 0, pollIntervalMs: 2500 })
  assert.equal((await send(unrelated, { unit: 'same source' })).statusCode, 200, 'non-source labels and polling status are not version locks')
  const other = cfg.createGroup(device.id, 'other slave', 3, 0, 4, 'read', 11)
  const otherPoint = cfg.createRegister(other.id, device.id, 'same address', 3, 0, 'uint16')
  const sourceIsolated = capture(); cfg.updateRegister(otherPoint.id, { unit: 'other source change' })
  assert.equal((await send(sourceIsolated, { unit: 'target only' })).statusCode, 200)
  assert.equal(cfg.getRegister(otherPoint.id)!.unit, 'other source change')

  const good = capture(); before = snapshot(); count = events
  for (const bad of [null, {}, [], { alias: 123 }, { groupId: 999 }, { factor: '2' }, { factor: null }, { factor: NaN }, { offset: Infinity }, { decimalPlaces: -1 }, { decimalPlaces: 9 }, { decimalPlaces: 1.5 }, { enumJson: {} }, { unit: false }, { dataType: 'unknown-type' }]) {
    // Direct store call also exercises NaN/Infinity, which JSON cannot represent.
    assert.throws(() => cfg.updateRegisterSettings(point.id, { expected: good, changes: bad }), error => (error as any).statusCode === 400)
    assert.equal(snapshot(), before); assert.equal(events, count)
  }
  for (const expected of [null, {}, { ...good, point: { ...good.point, id: 999 } }, { ...good, group: {} }, { ...good, device: {} }]) assert.equal((await send(expected, { unit: 'bad snapshot' })).statusCode, 400)
  assert.equal((await send(good, { unit: 'x' }, '/api/registers/1junk/settings')).statusCode, 400)
  assert.equal((await api.inject({ method: 'PUT', url: '/api/registers/' + point.id + '/settings', payload: { ...fullFields() } })).statusCode, 400, 'missing preconditions cannot fall back to an unguarded update')
  assert.equal((await send(capture(), { dataType: 'uint64' })).statusCode, 200, 'exact group-end width remains valid')
  cfg.updateRegister(point.id, { startAddress: 3 }); before = snapshot(); count = events
  assert.equal((await send(capture(), { dataType: 'uint32' })).statusCode, 400)
  assert.equal(snapshot(), before); assert.equal(events, count)
  cfg.updateRegister(point.id, { startAddress: 0, dataType: 'uint16' })

  // Bind snapshots to immutable primitive copies, not live config arrays or future refreshes.
  const mutable = JSON.parse(JSON.stringify(capture())), frozen = capturePointEditBaseline(mutable.point, mutable.group, mutable.device), frozenText = JSON.stringify(frozen)
  mutable.point.unit = 'changed outside'; mutable.group.slaveId = 99
  assert.equal(JSON.stringify(frozen), frozenText); assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.point) && Object.isFrozen(frozen.group) && Object.isFrozen(frozen.device))
  assert.deepEqual(parsePointEditRequest(JSON.parse(JSON.stringify({ expected: frozen, changes: { unit: null, factor: 0 } }))).expected, frozen)
  assert.ok(pointEditMatches(frozen, frozen, { factor: 0 }))

  // Database errors must roll back all fields and publish no change notification.
  const db = (cfg as any).db, prepare = db.prepare.bind(db), exec = db.exec.bind(db)
  for (const failure of ['update', 'readback', 'commit']) {
    let updated = false
    before = snapshot(); count = events
    db.prepare = (sql: string) => {
      if (sql.startsWith('UPDATE registers SET')) {
        if (failure === 'update') throw new Error('injected update failure')
        updated = true
      }
      if (failure === 'readback' && updated && sql.startsWith('SELECT id, group_id')) throw new Error('injected readback failure')
      return prepare(sql)
    }
    db.exec = (sql: string) => { if (failure === 'commit' && sql === 'COMMIT') throw new Error('injected commit failure'); return exec(sql) }
    try { assert.throws(() => cfg.updateRegisterSettings(point.id, { expected: capture(), changes: { unit: 'must roll back', factor: 77 } }), /injected/) }
    finally { db.prepare = prepare; db.exec = exec }
    assert.equal(snapshot(), before); assert.equal(events, count)
  }
  const rollbackExpected = capture(); count = events
  db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('injected transaction failure'); return exec(sql) }
  try {
    const uncertain = await send(rollbackExpected, { unit: 'uncertain transaction' })
    assert.equal(uncertain.statusCode, 500); assert.match(uncertain.json().error, /结果待核实/)
    assert.equal(events, count)
  } finally { db.exec = exec; exec('ROLLBACK') }
  assert.equal(cfg.getRegister(point.id)!.unit, rollbackExpected.point.unit)
  failNotify = true
  const notifyResult = await send(capture(), { unit: 'committed despite notification' })
  failNotify = false
  assert.equal(notifyResult.statusCode, 200); assert.equal(notifyResult.json().warnings.length, 1)
  assert.equal(cfg.getRegister(point.id)!.unit, 'committed despite notification')

  // Actual API + frontend write helper: one guarded request, verified response, no retry/fallback.
  const baseline = capture(), changes = { ...fullFields(baseline), factor: 0 }, calls: string[] = []
  const warnings = await saveGuardedPointSettings(baseline, changes, async (url, body) => {
    calls.push(url); const result = await api.inject({ method: 'PUT', url, payload: body as any })
    assert.equal(result.statusCode, 200); return result.json()
  })
  assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/settings')); assert.deepEqual(warnings, []); assert.equal(cfg.getRegister(point.id)!.factor, 0)
  const enumBeforeLarge = cfg.getRegister(point.id)!.enumJson, hugeSource = 'x'.repeat(1_100_000)
  cfg.updateRegister(point.id, { enumJson: hugeSource })
  await saveGuardedPointSettings(capture(), fullFields(), async (url, body) => {
    assert.ok(JSON.stringify(body).length < 4000, 'untouched enum source must not make scalar-only saves exceed the existing request body limit')
    const result = await api.inject({ method: 'PUT', url, payload: body as any })
    assert.equal(result.statusCode, 200); return result.json()
  })
  assert.equal(cfg.getRegister(point.id)!.enumJson, hugeSource)
  cfg.updateRegister(point.id, { enumJson: enumBeforeLarge })
  let attempts = 0
  await assert.rejects(saveGuardedPointSettings(capture(), fullFields(), async () => { attempts++; throw new Error('HTTP 404 unsupported server') }), /HTTP 404/)
  assert.equal(attempts, 1)
  for (const result of [null, {}, { point: cfg.getRegister(point.id), warnings: 'bad' }, { point: { ...cfg.getRegister(point.id), id: 999 }, warnings: [] }, { point: { ...cfg.getRegister(point.id), factor: 99 }, warnings: [] }]) await assert.rejects(saveGuardedPointSettings(capture(), fullFields(), async () => result), /结果待核实/)
  // Commit succeeds but the response is lost. Scalar-only saves must also preserve opaque enum bytes.
  const opaque = ' { "01": " On " } '; cfg.updateRegister(point.id, { enumJson: opaque })
  const lostExpected = capture(), lostChanges = { ...fullFields(), unit: 'committed response lost', factor: 0 }
  let lostRequests = 0; count = events
  await assert.rejects(saveGuardedPointSettings(lostExpected, lostChanges, async (url, body) => {
    lostRequests++; assert.equal((body as any).expected.point.enumJson, null); assert(!Object.hasOwn((body as any).changes, 'enumJson'))
    const response = await api.inject({ method: 'PUT', url, payload: body as any }); assert.equal(response.statusCode, 200)
    throw new TypeError('Failed to fetch')
  }), /保存结果待核实.*核对配置.*勿自动重复保存/)
  assert.equal(lostRequests, 1); assert.equal(events, count + 1)
  assert.equal(cfg.getRegister(point.id)!.unit, lostChanges.unit); assert.equal(cfg.getRegister(point.id)!.factor, 0); assert.equal(cfg.getRegister(point.id)!.enumJson, opaque)
  const lostGraph = snapshot(); count = events
  assert.equal((await send(lostExpected, lostChanges)).statusCode, 409, 'explicit stale retry must not silently overwrite or use an unguarded route')
  assert.equal(events, count); assert.equal(snapshot(), lostGraph)
  for (const error of [new Error('HTTP 500 unknown'), new Error('HTTP 502 gateway'), new SyntaxError('JSON lost'), new Error('AbortError'), new Error('HTTP 4000 not a status'), null, 'network failure']) {
    let requests = 0
    await assert.rejects(saveGuardedPointSettings(capture(), { unit: 'unknown' }, async () => { requests++; throw error }), /保存结果待核实.*勿自动重复保存/)
    assert.equal(requests, 1); assert.equal(snapshot(), lostGraph)
  }
  for (const status of [400, 403, 404, 409, 413, 415]) {
    const rejected = new Error('HTTP ' + status + ' synthetic rejection'); let requests = 0
    await assert.rejects(saveGuardedPointSettings(capture(), { unit: 'rejected' }, async () => { requests++; throw rejected }), error => error === rejected)
    assert.equal(requests, 1)
  }
  let invalidRequests = 0
  await assert.rejects(saveGuardedPointSettings(capture(), { factor: Infinity }, async () => { invalidRequests++; return null }), error => (error as any).statusCode === 400)
  assert.equal(invalidRequests, 0, 'local validation remains before the request, not an uncertain write')
  // Execute the production editor save callback, without mounting React or accessing the DOM.
  const source = ts.createSourceFile('PointSettingsEditor.tsx', readFileSync(new URL('../apps/web/src/PointSettingsEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'PointSettingsEditor') as ts.FunctionDeclaration
  const declaration = component.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(source) === 'save')!
  const code = ts.transpileModule('return (' + declaration.initializer!.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const formExpected = capture(), formSettings = cfg.getRegister(point.id)!, closeGuard = new PointDraftCloseGuard()
  let formError = '', busy = false, closed = 0, formRequests = 0, successfulSaves = 0
  const env = {
    lock: { current: false }, closeGuard, dataType: formSettings.dataType, unit: 'form committed response lost', factor: '0', offset: String(formSettings.offset), decimalPlaces: formSettings.decimalPlaces == null ? '' : String(formSettings.decimalPlaces),
    enums: createPointEnumDraft(formSettings.enumJson), settings: formSettings, available: group.quantity, t: (key: string) => key, parsePointSettingsUpdate,
    setError(value: string) { formError = value }, setBusy(value: boolean) { busy = value }, setEnumIssueIndex() {}, setEnumIssueRevision() {},
    closeAction(action: string) { if (action === 'close') closed++ },
    async onSave(value: any) {
      await saveGuardedPointSettings(formExpected, value, async (url, body) => {
        formRequests++; const response = await api.inject({ method: 'PUT', url, payload: body as any })
        if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body)
        throw new TypeError('Failed to fetch')
      }); successfulSaves++
    },
  }
  const save = new Function(...Object.keys(env), code)(...Object.values(env)) as () => Promise<void>
  const pending = save(); assert(busy); await save(); await pending
  assert.equal(formRequests, 1); assert.equal(successfulSaves, 0); assert.equal(closed, 0); assert(!busy); assert(closeGuard.canSave)
  assert.match(formError, /保存结果待核实.*勿自动重复保存/); assert.equal(env.unit, 'form committed response lost'); assert.equal(env.factor, '0')
  assert.equal(cfg.getRegister(point.id)!.unit, env.unit); assert.equal(cfg.getRegister(point.id)!.enumJson, opaque)
  const formGraph = snapshot(); count = events
  await Promise.resolve(); assert.equal(formRequests, 1, 'settling never retries the unknown save')
  await save(); assert.match(formError, /HTTP 409/); assert.equal(formRequests, 2); assert.equal(events, count); assert.equal(snapshot(), formGraph); assert.equal(closed, 0)
  assert.equal(closeGuard.request(true, false), 'prompt'); env.closeAction(closeGuard.discard(false))
  assert.equal(closed, 1); assert.equal(formRequests, 2); assert.equal(snapshot(), formGraph, 'discard is no write or undo')
  const deleted = capture(); cfg.deleteRegister(point.id); count = events
  assert.equal((await send(deleted, { unit: 'deleted' })).statusCode, 404); assert.equal(events, count)
} finally { await api.close(); (cfg as any).db.close() }

// A second SQLite connection cannot slip a write between compare and UPDATE.
const scratchParent = resolve(tmpdir()), scratch = mkdtempSync(join(scratchParent, 'probe-point-edit-'))
assert.equal(dirname(resolve(scratch)), scratchParent); assert.ok(basename(scratch).startsWith('probe-point-edit-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined
try {
  a = new ConfigStore({ dbPath: join(scratch, 'isolated.db') }); b = new ConfigStore({ dbPath: join(scratch, 'isolated.db') })
  const d = a.createObject('two-connection mock', 'mock.invalid', 502), g = a.createGroup(d.id, 'g', 3, 0, 1), p = a.createRegister(g.id, d.id, 'p', 3, 0, 'uint16')
  const expected = capturePointEditBaseline(a.getRegister(p.id), a.getGroup(g.id), a.getObject(d.id)), db = (a as any).db, prepare = db.prepare.bind(db)
  let blocked = 0
  db.prepare = (sql: string) => {
    if (sql.startsWith('UPDATE registers SET')) {
      assert.throws(() => b!.updateRegister(p.id, { unit: 'racing writer' }), /locked|busy/i); blocked++
    }
    return prepare(sql)
  }
  a.updateRegisterSettings(p.id, { expected, changes: { unit: 'guarded commit' } })
  db.prepare = prepare
  assert.equal(blocked, 1); assert.equal(b.getRegister(p.id)!.unit, 'guarded commit')
  b.updateRegister(p.id, { unit: 'later normal writer' })
  assert.throws(() => a!.updateRegisterSettings(p.id, { expected, changes: { unit: 'stale' } }), error => (error as any).statusCode === 409)
  const readGroup = a.getGroup.bind(a)
  let interleaved = false
  a.getGroup = id => { if (!interleaved) { interleaved = true; assert.throws(() => b!.updateGroup(id, { slaveId: 9 }), /locked|busy/i) }; return readGroup(id) }
  const coherent = a.getRegisterSettings(p.id)
  a.getGroup = readGroup
  assert.equal(coherent.group.slaveId, 1, 'one read transaction prevents a second connection from committing an inconsistent source')
  b.updateGroup(g.id, { slaveId: 9 })
  assert.equal(a.getRegisterSettings(p.id).group.slaveId, 9)
  assert.throws(() => a!.updateRegisterSettings(p.id, { expected: coherent, changes: { alias: 'stale source read' } }), error => (error as any).statusCode === 409)
} finally {
  if (a) (a as any).db.close(); if (b) (b as any).db.close()
  assert.equal(dirname(resolve(scratch)), scratchParent); assert.ok(basename(scratch).startsWith('probe-point-edit-')); rmSync(scratch, { recursive: true, force: true })
}
const html = renderToStaticMarkup(createElement(PointSettingsEditor, { guarded: true, name: '<synthetic>', address: 0, settings: { dataType: 'uint16', unit: null, factor: 1, offset: 0, enumJson: null }, available: 1, typeGroups: [], t: key => key, onClose() {}, async onSave() { throw new Error('must not save during SSR') } }))
assert.match(html, /冲突会拒绝保存并保留草稿/); assert.doesNotMatch(html, /<synthetic>/)
console.log('POINT EDIT CONFLICT OK: stale scalar and explicit-enum rejection, omitted-enum preservation, frozen source baselines, same-address isolation, strict input/readback, atomic rollback/notification warnings, guarded API/client no-fallback, committed response loss with production editor save callback/unknown message/draft/busy/no-close/no-retry/stale retry conflict/discard without undo, known rejections and local validation, two-connection SQLite lock; memory/isolated temporary DB only, no DOM automation')
