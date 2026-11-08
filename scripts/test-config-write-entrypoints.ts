import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerPointSettings } from '../packages/api/src/point-settings.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { saveGuardedPointSettings } from '../apps/web/src/point-settings-save.ts'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from '../apps/web/src/group-settings-save.ts'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteBlocked, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
import { draftEditor } from './fixtures/draft-navigation-driver.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

const parse = (file: string) => ts.createSourceFile(file, readFileSync(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const web = parse('apps/web/src/App.tsx'), api = parse('packages/api/src/index.ts')
const compile = (code: string, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
const requestNode = web.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
const app = web.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App') as ts.FunctionDeclaration
const addDevice = app.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(web) === 'addDevice')!
const tick = () => new Promise<void>(done => setImmediate(done)), passed: string[] = [], failures: string[] = [], unhandled: unknown[] = []
const collect = (error: unknown) => unhandled.push(error)
type Kind = 'point' | 'device' | 'group'
async function fixture(quarantine = true) {
  let notices = 0, hooks = 0, requests = 0, writes = 0
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { notices++ }), http = Fastify()
  const device = cfg.createObject('synthetic', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic', 3, 0, 2), point = cfg.createRegister(group.id, device.id, 'synthetic', 3, 0, 'uint16')
  const expected = cfg.getRegisterSettings(point.id), baseline = captureDeviceEditBaseline(device), db = (cfg as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db), prepare = db.prepare.bind(db)
  registerPointSettings(http, cfg)
  const mount = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && ['/api/monitor_objects', '/api/monitor_objects/:id/groups'].includes(node.arguments[0].text)) compile(node.getText(api), { fastify: http, cfg, ctx: { get() { return { async sync() { hooks++ } } } } }); ts.forEachChild(node, mount) }; mount(api)
  let forced: { status: number; body: unknown } | undefined, lose = false, lastStatus = 0, lastBody: any
  const request = compile('return (' + requestNode.getText(web) + ')', { fetch: async (url: string, options: RequestInit) => {
    assert(['POST', 'PUT'].includes(options.method!)); requests++
    const response = forced ? null : await http.inject({ method: options.method as 'POST' | 'PUT', url, payload: JSON.parse(String(options.body)) })
    const status = forced?.status ?? response!.statusCode, body = forced?.body ?? response!.json(); lastStatus = status; lastBody = body
    if (response) assert(!JSON.stringify(body).includes('PRIVATE'))
    if (lose) throw Error('synthetic lost response')
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  }, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED })
  const send = (method: 'PUT' | 'POST', url: string, body: unknown) => request(url, { method, body: JSON.stringify(body) })
  if (quarantine) { db.exec = sql => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw Error('PRIVATE transaction'); return exec(sql) }; assert.throws(() => cfg.updateGroup(group.id, { quantity: 3 }), AggregateError); db.exec = exec }
  return { cfg, http, db, exec, prepare, device, baseline, expected, send,
    stats: () => ({ notices, hooks, requests, writes, lastStatus, lastBody }), force(value?: typeof forced) { forced = value }, lose(value: boolean) { lose = value },
    forbidSQL() { db.exec = () => { writes++; assert.fail('blocked request SQL') }; db.prepare = () => { writes++; assert.fail('blocked request prepare') } },
    async close() { db.exec = exec; db.prepare = prepare; if (db.isTransaction) exec('ROLLBACK'); await http.close(); await cfg.close() },
  }
}
async function perform(kind: Kind, f: Awaited<ReturnType<typeof fixture>>, message: RegExp, english = false) {
  let pending: Promise<unknown> | undefined, closed = 0, refreshed = 0, saved = 0
  const start = f.stats().requests
  const create = (url: string, body: unknown) => pending = f.send('POST', url, body)
  if (kind === 'group') {
    const driver = hookDriver('GroupModal.tsx', 'GroupModal', { captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }, { device: f.baseline, initial: null, t: (key: string) => english && key === 'cancel' ? 'Cancel' : key, onClose() { closed++ }, onSaved() { saved++ }, get() { assert.fail('new group GET') }, put() { assert.fail('new group PUT') }, create })
    try { driver.one('input').props.onChange({ target: { value: 'UNSAVED DRAFT' } }); driver.render(); driver.one('form').props.onSubmit({ preventDefault() {} }); assert(pending); await pending.catch(() => {}); await tick(); driver.render(); assert.match(driver.one('div', props => props.role === 'alert').props.children, message); assert.equal(driver.one('input').props.value, 'UNSAVED DRAFT') }
    finally { driver.dispose() }
  } else {
    const callback = kind === 'point' ? (fields: any) => pending = saveGuardedPointSettings(f.expected, fields, (url, body) => f.send('PUT', url, body)) : compile('return (' + (addDevice.initializer as ts.CallExpression).arguments[0].getText(web) + ')', { api: { post: create }, configurationWriteBlocked, setShowAdd() { closed++ }, refreshDevices() { refreshed++ }, operation: { setNotice() { saved++ } }, t: (key: string) => key })
    const editor = draftEditor(kind === 'point' ? 'point' : 'device', undefined, async fields => { await callback(fields) }, null, undefined, null)
    try { editor.change('UNSAVED DRAFT'); if (kind === 'device') { editor.driver.one('input', props => props['aria-label'] === 'ip').props.onChange({ target: { value: 'mock.invalid' } }); editor.driver.render() }; editor.submit(); assert(pending); await pending.catch(() => {}); await tick(); editor.driver.render(); assert.match(editor.driver.one('div', props => props.role === 'alert').props.children, message); assert.equal(editor.value(), 'UNSAVED DRAFT'); assert.equal(editor.calls.close, 0); editor.close(); editor.resume(); assert.equal(editor.value(), 'UNSAVED DRAFT') }
    finally { editor.driver.dispose() }
  }
  await tick(); assert.equal(f.stats().requests, start + 1); assert.equal(closed + refreshed + saved, 0)
}
async function check(name: string, action: () => Promise<void>) { try { await action(); passed.push(name); console.log('CONFIG WRITE ENTRY OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('CONFIG WRITE ENTRY REPRO: ' + failures.at(-1)) } }
process.on('unhandledRejection', collect)
try {
  for (const kind of ['point', 'device', 'group'] as Kind[]) await check(kind + '-quarantined-before-operation-keeps-draft', async () => { const f = await fixture(); try { const before = f.stats(); f.forbidSQL(); await perform(kind, f, kind === 'point' ? /本次保存未执行/ : /本次创建未执行/); if (kind === 'group') await perform(kind, f, /This creation did not run/, true); assert.equal(f.stats().lastStatus, 503); assert.equal(f.stats().lastBody.code, 'CONFIG_WRITE_NOT_STARTED'); assert.equal(f.stats().lastBody.outcome, 'not-applied'); assert.equal(f.stats().writes, 0); assert.equal(f.stats().hooks, 0); assert.equal(f.stats().notices, before.notices) } finally { await f.close() } })
  await check('generic-status-incomplete-receipt-and-lost-response-stay-unknown', async () => { const f = await fixture(); try { for (const kind of ['point', 'device', 'group'] as Kind[]) { for (const [status, body] of [[503, {}], [503, { version: 2, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }], [503, { version: 1, code: 'CONFIG_TRANSACTION_UNCONFIRMED', outcome: 'not-applied' }], [503, { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'unknown' }], [500, { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }]] as const) { f.force({ status, body }); await perform(kind, f, /待核实/) }; f.force(); f.lose(true); await perform(kind, f, /待核实/); f.lose(false) } } finally { await f.close() } })
  await check('point-original-transaction-fault-remains-unknown-before-next-rejection', async () => { for (const acknowledged of [false, true]) { const f = await fixture(false); try { f.db.exec = sql => { if (sql === 'COMMIT') { if (acknowledged) f.exec(sql); throw Error('PRIVATE commit') }; if (sql === 'ROLLBACK') throw Error('PRIVATE rollback'); return f.exec(sql) }; await perform('point', f, /待核实/); assert.equal(f.stats().lastStatus, 500); assert.equal(f.stats().lastBody.code, undefined); assert.equal(f.db.isTransaction, !acknowledged); f.db.exec = f.exec; await perform('point', f, /本次保存未执行/) } finally { await f.close() } } })
  await tick(); assert.deepEqual(failures, []); assert.deepEqual(unhandled, [])
} finally { process.off('unhandledRejection', collect) }
console.log('CONFIG WRITE ENTRY TEST OK: ' + passed.length + ' actual point/new-device/new-group routes, HTTP adapter and modal groups; no automatic retry, recovery, listeners, real data or hardware')
