import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerConfigBackup } from '../packages/api/src/config-backup.ts'
import { ConfigBackupFlow, parseBackupPreview, parseBackupRestoreResult } from '../apps/web/src/config-backup-flow.ts'
import { ConfigBackupView, ConfigBackupSettings } from '../apps/web/src/ConfigBackupSettings.tsx'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const counts = { devices: 1, groups: 0, registers: 0, rules: 0 }
const body = JSON.stringify({ format: 'probestation-config', version: 1, createdAt: '2026-11-06T00:00:00Z', devices: [{ fixtureOnly: 'private fixture input' }], groups: [], registers: [], rules: [] })
const preview = { counts, devices: [{ name: '<mock device>', mode: 'master' as const, transport: 'rtu' as const, endpoint: null, sameName: false }] }
const result = { ...counts, deviceIds: [11], warnings: ['mock notification warning'] }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
for (const invalid of [null, {}, { ...preview, counts: { ...counts, devices: 2 } }, { ...preview, devices: [] }, { ...preview, devices: [{ ...preview.devices[0], sameName: 'yes' }] }, { ...preview, devices: [{ ...preview.devices[0], endpoint: 1 }] }]) assert.throws(() => parseBackupPreview(invalid, counts))
for (const invalid of [null, {}, { ...result, devices: 2 }, { ...result, deviceIds: [] }, { ...result, deviceIds: [0] }, { ...result, warnings: ['valid', 1] }]) assert.throws(() => parseBackupRestoreResult(invalid, counts))
assert.throws(() => parseBackupRestoreResult({ ...result, devices: 2, deviceIds: [11, 11] }, { ...counts, devices: 2 }))
assert.deepEqual(parseBackupRestoreResult({ ...counts, deviceIds: [11] }, counts).warnings, [], 'legacy successful responses without warnings remain compatible')

// Real API and isolated SQLite prove a lost success response cannot cause a second restore from the same proposal.
const source = new ConfigStore({ dbPath: ':memory:' }), target = new ConfigStore({ dbPath: ':memory:' }), api = Fastify()
registerConfigBackup(api, target)
try {
  source.createObject('Mock restore source', '127.0.0.1', 1502, 'slave')
  const text = JSON.stringify(source.exportBackup()), calls: string[] = []
  const flow = new ConfigBackupFlow(async (url, options) => {
    calls.push(String(url)); assert.equal(options?.method, 'POST'); assert.equal(typeof options?.body, 'string')
    const restoring = String(url).endsWith('/restore')
    if (restoring) assert.equal(Object.hasOwn(options!, 'signal'), false, 'writes receive no abort signal')
    const res = await api.inject({ method: 'POST', url: String(url), headers: options!.headers as Record<string, string>, payload: options!.body as string })
    assert.equal(res.statusCode, 200)
    if (restoring) throw new Error('mock lost response after committed restore')
    return new Response(res.body, { status: res.statusCode })
  })
  await flow.preview('mock.json', async () => text); assert.equal(flow.snapshot().phase, 'ready')
  assert.equal(target.listObjects().length, 0)
  const first = flow.restore(), second = flow.restore(); await Promise.all([first, second])
  assert.equal(flow.snapshot().phase, 'uncertain'); assert.equal(target.listObjects().length, 1)
  assert.equal(target.listObjects()[0].isActive, 0)
  flow.cancelPreview(); await flow.restore()
  assert.equal(flow.snapshot().phase, 'uncertain'); assert.equal(calls.filter(url => url.endsWith('/restore')).length, 1)
  await flow.preview('mock.json', async () => text)
  assert.equal(flow.snapshot().phase, 'ready'); assert.equal(flow.snapshot().preview!.devices[0].sameName, true)
  assert.equal(target.listObjects().length, 1, 'a new preview is read-only, even after an uncertain restore')
} finally { await api.close(); (source as any).db.close(); (target as any).db.close() }

let restoreCalls = 0, previewCalls = 0
const inFlight = deferred<Response>(), started = deferred<void>()
const flow = new ConfigBackupFlow(async (url, options) => {
  assert.equal(options!.headers && (options!.headers as Record<string, string>)['x-probestation-config'], '1')
  if (String(url).endsWith('/preview')) { previewCalls++; return response(preview) }
  restoreCalls++; assert.equal(options!.body, body); assert.equal(Object.hasOwn(options!, 'signal'), false)
  started.resolve(); return inFlight.promise
}, { slowRestoreMs: 5 })
await flow.preview('<mock>.json', async () => body)
const ready = flow.snapshot(); assert.equal(ready.phase, 'ready')
assert.ok(Object.isFrozen(ready.preview!.counts)); assert.ok(!JSON.stringify(ready).includes('private fixture input'), 'operation journal contains metadata, never the full backup body')
let received = 0
const unsubscribe = flow.subscribe(() => { received++ })
const pending = flow.restore(); await started.promise; assert.equal(flow.snapshot().phase, 'restoring')
await flow.restore(); await flow.preview('other.json', async () => { throw new Error('must not read another backup during restore') })
unsubscribe(); const beforeClose = received; flow.cancelPreview()
await new Promise<void>(resolve => { if (flow.snapshot().slow) resolve(); else { const done = flow.subscribe(() => { if (flow.snapshot().slow) { done(); resolve() } }) } })
assert.equal(received, beforeClose, 'closed views receive no callbacks; mutation itself is retained')
assert.equal(flow.snapshot().phase, 'restoring'); assert.equal(flow.snapshot().slow, true)
let reopened = 0; const closeAgain = flow.subscribe(() => { reopened++ })
inFlight.resolve(response(result)); await pending
assert.equal(reopened, 1); closeAgain()
assert.equal(flow.snapshot().phase, 'completed'); assert.equal(restoreCalls, 1); assert.equal(previewCalls, 1)
assert.deepEqual(flow.snapshot().result!.deviceIds, [11]); assert.deepEqual(flow.snapshot().result!.warnings, result.warnings)
await flow.restore(); assert.equal(restoreCalls, 1, 'completed proposal cannot be sent again')
flow.cancelPreview(); assert.equal(flow.snapshot().phase, 'completed', 'closing settings retains the last outcome in this browser tab')

for (const [status, phase] of [[400, 'rejected'], [403, 'rejected'], [413, 'rejected'], [415, 'rejected'], [500, 'uncertain'], [502, 'uncertain']] as const) {
  let writes = 0
  const failure = new ConfigBackupFlow(async url => String(url).endsWith('/preview') ? response(preview) : (writes++, response({ error: '<mock server detail>' }, status)))
  await failure.preview('mock.json', async () => body); await failure.restore(); await failure.restore()
  assert.equal(failure.snapshot().phase, phase); assert.equal(writes, 1)
  if (phase === 'uncertain') assert.equal(failure.snapshot().detail, 'HTTP ' + status, 'unconfirmed writes do not echo untrusted server errors as proof of rollback')
}
for (const restoreResponse of [response({ ...result, groups: 9 }), new Response('not json'), response({ ...result, deviceIds: [0] })]) {
  const malformed = new ConfigBackupFlow(async url => String(url).endsWith('/preview') ? response(preview) : restoreResponse)
  await malformed.preview('mock.json', async () => body); await malformed.restore()
  assert.equal(malformed.snapshot().phase, 'uncertain', 'a 2xx status alone does not prove a coherent restore result')
}

let fetched = 0
const invalidFile = new ConfigBackupFlow(async () => { fetched++; return response(preview) })
for (const input of ['not json', '{}', JSON.stringify({ ...JSON.parse(body), version: 2 })]) { await invalidFile.preview('bad.json', async () => input); await invalidFile.restore(); assert.equal(invalidFile.snapshot().phase, 'preview-error') }
assert.equal(fetched, 0)
const invalidPreview = new ConfigBackupFlow(async () => response({ ...preview, counts: { ...counts, registers: 2 } }))
await invalidPreview.preview('mock.json', async () => body); await invalidPreview.restore(); assert.equal(invalidPreview.snapshot().error, 'invalid-preview')
const lateRead = deferred<string>(), lateStarted = deferred<void>()
const latest = new ConfigBackupFlow(async () => response(preview))
const oldRead = latest.preview('old.json', () => { lateStarted.resolve(); return lateRead.promise })
await lateStarted.promise; await latest.preview('new.json', async () => body); lateRead.resolve('bad old json'); await oldRead
assert.equal(latest.snapshot().phase, 'ready'); assert.equal(latest.snapshot().fileName, 'new.json')
latest.cancelPreview(); await latest.restore(); assert.equal(latest.snapshot().phase, 'idle')
const oldPreview = deferred<Response>(), oldPreviewStarted = deferred<void>(); let previewNumber = 0
const latestResponse = new ConfigBackupFlow(async () => { if (++previewNumber === 1) { oldPreviewStarted.resolve(); return oldPreview.promise }; return response(preview) })
const obsolete = latestResponse.preview('obsolete.json', async () => body)
await oldPreviewStarted.promise; await latestResponse.preview('current.json', async () => body)
oldPreview.resolve(response({ ...preview, devices: [{ ...preview.devices[0], name: 'obsolete response' }] })); await obsolete
assert.equal(latestResponse.snapshot().fileName, 'current.json'); assert.equal(latestResponse.snapshot().preview!.devices[0].name, preview.devices[0].name, 'late preview response cannot replace a newer proposal even if fetch ignores abort')
const zeros = { devices: 0, groups: 0, registers: 0, rules: 0 }
const emptyFlow = new ConfigBackupFlow(async url => response(String(url).endsWith('/preview') ? { counts: zeros, devices: [] } : { ...zeros, deviceIds: [] }))
await emptyFlow.preview('empty.json', async () => JSON.stringify({ ...JSON.parse(body), devices: [] })); await emptyFlow.restore()
assert.equal(emptyFlow.snapshot().phase, 'completed'); assert.equal(emptyFlow.snapshot().result!.devices, 0)
const neverRead = deferred<string>()
const timeout = new ConfigBackupFlow(async () => { fetched++; return response(preview) }, { previewTimeoutMs: 5 })
await timeout.preview('timeout.json', () => neverRead.promise)
assert.equal(timeout.snapshot().error, 'preview-timeout'); neverRead.resolve(body); await Promise.resolve(); assert.equal(fetched, 0)
const previewSignal = deferred<AbortSignal>()
const cancellable = new ConfigBackupFlow(async (_url, options) => { previewSignal.resolve(options!.signal!); return new Promise(() => {}) })
const cancelling = cancellable.preview('cancel.json', async () => body)
const signal = await previewSignal.promise; cancellable.cancelPreview(); await cancelling
assert.equal(signal.aborted, true); assert.equal(cancellable.snapshot().phase, 'idle')

let actions = 0
const render = (state = flow.snapshot(), zh = true) => renderToStaticMarkup(createElement(ConfigBackupView, { state, zh, onChoose() { actions++ }, onCancel() { actions++ }, onRestore() { actions++ } }))
assert.match(render(ready), /确认新增并恢复/); assert.match(render(ready), /&lt;mock&gt;/)
assert.match(render(), /mock notification warning/); assert.match(render(), /#11/); assert.match(render(), /配置已恢复/)
assert.match(render({ ...flow.snapshot(), phase: 'uncertain', result: null }), /恢复结果待核实/)
assert.doesNotMatch(render({ ...flow.snapshot(), phase: 'uncertain', result: null }), /确认新增并恢复/)
assert.match(render({ ...flow.snapshot(), phase: 'restoring', result: null, slow: true }), /连接中断不能证明已回滚/)
assert.match(render({ ...flow.snapshot(), phase: 'restoring', result: null }), /disabled=""/)
assert.match(render(timeout.snapshot()), /未执行恢复/)
assert.match(render(flow.snapshot(), false), /Configuration restored/)
assert.ok(renderToStaticMarkup(createElement(ConfigBackupSettings, { lang: 'zh', flow })).includes('#11'), 'a remounted settings view renders the retained journal without sending another request')
assert.equal(actions, 0)
console.log('CONFIG BACKUP FLOW OK: actual memory/API committed-response loss, single-use proposal, retained pending/completed state across subscribers, slow-write hint without abort, rejection vs uncertainty, preview cancellation/timeout/stale reads, strict contracts and SSR; no real configuration, devices or external network')
