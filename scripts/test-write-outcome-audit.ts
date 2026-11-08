import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { registerDeviceSettings } from '../packages/api/src/device-settings.ts'
import { registerPointSettings } from '../packages/api/src/point-settings.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { saveGuardedDeviceSettings } from '../apps/web/src/device-settings-save.ts'
import { saveGuardedPointSettings } from '../apps/web/src/point-settings-save.ts'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from '../apps/web/src/group-settings-save.ts'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteBlocked, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
import { uploadPointBook, pointBookReportKind } from '../apps/web/src/pointbook-result.ts'
import { draftSurface } from './fixtures/draft-navigation-driver.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

const source = (name: string) => ts.createSourceFile(name, readFileSync(new URL('../' + name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const web = source('apps/web/src/App.tsx'), api = source('packages/api/src/index.ts')
const compile = (text: string, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
const request = web.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
let add!: ts.VariableDeclaration
const find = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(web) === 'addDevice') add = node; ts.forEachChild(node, find) }; find(web)
const kinds = ['device-edit', 'point-edit', 'create-device', 'create-group', 'delete', 'import'] as const
type Kind = typeof kinds[number]
type Wire = { status: number; body: any }
const receipt = { error: '配置连接已隔离，本次保存未执行。', version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }
const importReceipt = { ...receipt, report: { groups: 0, registers: 0, errors: ['本次导入未执行。'], warnings: [] } }
const tick = () => new Promise<void>(done => setImmediate(done)), failures: string[] = [], passed: string[] = [], unhandled: unknown[] = []
const collect = (error: unknown) => unhandled.push(error)
async function fixture(kind: Kind, options: { quarantine?: boolean; notify?: boolean; skip?: Wire; transform?: (wire: Wire) => Wire; drop?: boolean } = {}) {
  let armed = false, calls = 0, successes = 0, received: Wire | undefined
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (armed && options.notify) throw Error('PRIVATE notify after commit') }), app = Fastify()
  const d = cfg.createObject('synthetic', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'old', 3, 0, 1), p = cfg.createRegister(g.id, d.id, 'old', 3, 0, 'uint16'), baseline = captureDeviceEditBaseline(d), point = cfg.getRegisterSettings(p.id)
  const from = cfg.createObject('source', 'mock.invalid', 502), sg = cfg.createGroup(from.id, 'replacement', 4, 8, 1); cfg.createRegister(sg.id, from.id, 'replacement', 4, 8, 'uint16')
  const sink = new Sink({ config: cfg }), buffer = (await sink.exportPointSheet(from.id)).buffer, file = new Blob([Uint8Array.from(buffer)])
  const db = (cfg as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db)
  const graph = () => JSON.stringify(['monitor_objects', 'register_groups', 'registers', 'alarm_rules'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()))
  registerDeviceSettings(app, cfg, { reconnect: async () => {}, syncSlaves: async () => {} }); registerPointSettings(app, cfg)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  const mount = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && (node.expression.name.text === 'post' && ['/api/monitor_objects', '/api/monitor_objects/:id/groups', '/api/monitor_objects/:id/points/book'].includes(node.arguments[0].text) || node.expression.name.text === 'delete' && node.arguments[0].text === '/api/monitor_objects/:id')) compile(node.getText(api), { fastify: app, cfg, sink, ctx: { get() { return { async sync() {} } } } }); ts.forEachChild(node, mount) }; mount(api)
  if (options.quarantine) { db.exec = sql => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw Error('PRIVATE quarantine'); return exec(sql) }; assert.throws(() => cfg.updateGroup(g.id, { quantity: 2 }), AggregateError); db.exec = exec; if (db.isTransaction) exec('ROLLBACK') }
  const before = graph(); armed = true
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++; let wire = options.skip
    if (!wire) { const payload = init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : init.body ? JSON.parse(String(init.body)) : undefined; const response = await app.inject({ method: init.method as 'POST' | 'PUT' | 'DELETE', url, headers: (init.headers ?? {}) as Record<string, string>, payload }); wire = { status: response.statusCode, body: response.json() } }
    if (options.drop) throw new DOMException('synthetic browser disconnect after admission', 'AbortError')
    wire = options.transform?.(wire) ?? wire
    received = wire
    return new Response(JSON.stringify(wire.body), { status: wire.status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const http = compile('return (' + request.getText(web) + ')', { fetch: fetcher, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED })
  const post = (url: string, body: unknown) => http(url, { method: 'POST', body: JSON.stringify(body) }), put = (url: string, body: unknown) => http(url, { method: 'PUT', body: JSON.stringify(body) })
  const classify = (error: unknown) => error instanceof Error && /本次(?:保存|创建|删除)未执行/.test(error.message) ? 'not-started' : error instanceof Error && /后台报告|Backend reports/.test(error.message) && /待核实|unverified/.test(error.message) ? 'reported' : 'unknown'
  async function run(): Promise<'success' | 'not-started' | 'reported' | 'unknown'> {
    try {
      if (kind === 'device-edit') await saveGuardedDeviceSettings(baseline, { name: 'changed' }, put)
      else if (kind === 'point-edit') await saveGuardedPointSettings(point, { unit: 'changed' }, put)
      else if (kind === 'create-device') { const callback = compile('return (' + (add.initializer as ts.CallExpression).arguments[0].getText(web) + ')', { api: { post }, configurationWriteBlocked, setShowAdd() { successes++ }, refreshDevices() {}, operation: { setNotice() {} }, t: (key: string) => key }); await callback({ ...baseline, name: 'created' }); assert.equal(successes, 1) }
      else if (kind === 'create-group') {
        let pending: Promise<unknown> | undefined
        const driver = hookDriver('GroupModal.tsx', 'GroupModal', { captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }, { device: baseline, initial: null, t: (key: string) => key, onClose() {}, onSaved() { successes++ }, get() { assert.fail() }, put() { assert.fail() }, create(url: string, body: unknown) { return pending = post(url, body) } })
        try { driver.one('input').props.onChange({ target: { value: 'created' } }); driver.render(); driver.one('form').props.onSubmit({ preventDefault() {} }); assert(pending); await pending.catch(() => {}); await tick(); driver.render(); if (!successes) return classify(Error(driver.one('div', props => props.role === 'alert').props.children)) } finally { driver.dispose() }
      } else if (kind === 'delete') { const page = draftSurface(); page.setAnswer(true); await page.deleteDevice(1, url => http(url, { method: 'DELETE' })); if (page.notices.at(-1)?.error) return classify(Error(page.notices.at(-1)!.text)); assert.equal(page.state().selectedId, null) }
      else { const report = await uploadPointBook(d.id, file, fetcher); return pointBookReportKind(report) === 'completed' ? 'success' : report.groups === 0 && report.registers === 0 && report.errors.some(text => text.includes('本次导入未执行')) ? 'not-started' : 'unknown' }
      return 'success'
    } catch (error) { if (kind === 'import' && received?.body?.code === 'CONFIG_WRITE_NOT_STARTED') assert(!String(error).includes('本次保存未执行'), 'unverified import details must not repeat a definite refusal claim'); return classify(error) }
  }
  return { run, changed: () => graph() !== before, calls: () => calls, async close() { db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); await app.close(); await cfg.close() } }
}
async function check(name: string, action: () => Promise<void>) { try { await action(); passed.push(name); console.log('WRITE AUDIT OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('WRITE AUDIT REPRO: ' + failures.at(-1)) } }
process.on('unhandledRejection', collect)
try {
  await check('honest-receipts-are-backend-reports-with-unverified-current-outcome', async () => { for (const kind of kinds) { const f = await fixture(kind, { quarantine: true }); try { assert.equal(await f.run(), 'reported', kind); assert(!f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('old-server-incomplete-marker-and-status-only-proxies-stay-unknown', async () => { for (const kind of kinds) for (const wire of [{ status: 503, body: { error: 'old unavailable', code: 'CONFIG_TRANSACTION_UNCONFIRMED' } }, { status: 503, body: { ...receipt, version: 2 } }, { status: 503, body: { error: 'old proxy' } }, { status: 500, body: kind === 'import' ? importReceipt : receipt }]) { const f = await fixture(kind, { skip: wire }); try { assert.equal(await f.run(), 'unknown', kind); assert(!f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('refusal-markers-under-rewritten-known-4xx-do-not-claim-no-write', async () => { for (const kind of kinds) for (const status of [400, 403, 404, 409, 413, 415]) { const f = await fixture(kind, { skip: { status, body: kind === 'import' ? importReceipt : receipt } }); try { assert.equal(await f.run(), 'unknown', kind + '/' + status); assert(!f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('mixed-success-and-refusal-content-is-not-proof-of-no-write', async () => { for (const kind of kinds) { const f = await fixture(kind, { transform: wire => ({ status: 503, body: { ...wire.body, ...(kind === 'import' ? importReceipt : receipt) } }) }); try { assert.equal(await f.run(), 'unknown', kind); assert(f.changed(), 'actual backend committed ' + kind); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('refusal-body-under-proxy-2xx-is-not-a-success-or-verified-refusal', async () => { for (const kind of kinds) { const f = await fixture(kind, { quarantine: true, transform: wire => ({ ...wire, status: 200 }) }); try { assert.equal(await f.run(), 'unknown', kind); assert(!f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('postcommit-notifications-and-browser-disconnect-do-not-imply-no-write', async () => { for (const kind of kinds) for (const mode of ['notify', 'drop', 'status'] as const) { const f = await fixture(kind, { notify: mode === 'notify', drop: mode === 'drop', transform: mode === 'status' ? wire => ({ ...wire, status: 503 }) : undefined }); try { const outcome = await f.run(); assert.equal(outcome, mode === 'notify' && !['create-device', 'delete'].includes(kind) ? 'success' : 'unknown', kind + '/' + mode); assert(f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } } })
  await check('clean-replayed-receipts-never-prove-no-write-for-all-six-operations', async () => { for (const kind of kinds) { const f = await fixture(kind, { transform: () => ({ status: 503, body: kind === 'import' ? importReceipt : receipt }) }); try { assert.equal(await f.run(), 'reported', kind); assert(f.changed()); assert.equal(f.calls(), 1) } finally { await f.close() } }; console.log('WRITE AUDIT TRUST BOUNDARY: clean forged/replayed receipts remain indistinguishable. UI now attributes them to the backend and keeps the actual outcome unverified; no authentication, correlation or replay detection is claimed.') })
  await tick(); assert.deepEqual(failures, []); assert.deepEqual(unhandled, [])
} finally { process.off('unhandledRejection', collect) }
console.log('WRITE AUDIT TEST OK: ' + passed.length + ' six-operation compatibility/proxy/notification/disconnect and explicit trust-boundary groups; generated XLSX/memory databases/inject only, no retries, recovery, listeners, real data or hardware')
