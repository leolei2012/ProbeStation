import assert from 'node:assert/strict'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { registerActivationSettings } from '../packages/api/src/activation-settings.ts'
import { captureActivation } from '../packages/core/src/activation-settings.ts'
import { ActivationUncertainError, saveActivation } from '../apps/web/src/activation-settings-save.ts'
import { InvalidPointBookReportError, uploadPointBook, pointBookReportKind } from '../apps/web/src/pointbook-result.ts'
import { PointBookImportResult, type PointBookResult } from '../apps/web/src/PointBookImportResult.tsx'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'

const source = (name: string) => ts.createSourceFile(name, readFileSync(new URL('../' + name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const api = source('packages/api/src/index.ts'), web = source('apps/web/src/App.tsx')
const compile = (code: string, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
const request = web.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
let importCallback!: ts.VariableDeclaration
const findImport = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(web) === 'uploadBook') importCallback = node; ts.forEachChild(node, findImport) }; findImport(web)
const passed: string[] = [], failures: string[] = [], unhandled: unknown[] = [], tick = () => new Promise<void>(done => setImmediate(done))
const collect = (error: unknown) => unhandled.push(error)
async function fixture(quarantine = true) {
  let notifications = 0, syncs = 0, imports = 0, requests = 0, sql = 0
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { notifications++ }), http = Fastify()
  const target = cfg.createObject('synthetic target', 'mock.invalid', 502), g = cfg.createGroup(target.id, 'old', 3, 0, 1), p = cfg.createRegister(g.id, target.id, 'old', 3, 0, 'uint16'); cfg.createRule(p.id, '>', 1, 'old')
  const from = cfg.createObject('synthetic source', 'mock.invalid', 502), sg = cfg.createGroup(from.id, 'replacement', 4, 8, 1); cfg.createRegister(sg.id, from.id, 'new', 4, 8, 'uint16')
  const sink = new Sink({ config: cfg }), buffer = (await sink.exportPointSheet(from.id)).buffer, originalImport = sink.importPointBook.bind(sink)
  sink.importPointBook = async (...args) => { imports++; return originalImport(...args) }
  const file = Object.assign(new Blob([Uint8Array.from(buffer)]), { name: 'synthetic.xlsx' }), db = (cfg as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db), prepare = db.prepare.bind(db)
  http.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  const mount = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]) && (node.expression.name.text === 'delete' && node.arguments[0].text === '/api/monitor_objects/:id' || node.expression.name.text === 'post' && node.arguments[0].text === '/api/monitor_objects/:id/points/book')) compile(node.getText(api), { fastify: http, cfg, sink, ctx: { get() { return { async sync() { syncs++ } } } } }); ts.forEachChild(node, mount) }; mount(api)
  registerActivationSettings(http, cfg, { syncSlaves: async () => { syncs++ } })
  let force: { status: number; body: unknown } | undefined, lost = false, lastStatus = 0, lastBody: any
  const fetcher = (async (url: string, options: RequestInit) => {
    requests++; assert(['DELETE', 'POST', 'PUT'].includes(options.method!))
    const payload = options.body instanceof Blob ? Buffer.from(await options.body.arrayBuffer()) : options.body ? JSON.parse(String(options.body)) : undefined
    const response = force ? null : await http.inject({ method: options.method as 'DELETE' | 'POST' | 'PUT', url, headers: options.headers as Record<string, string> ?? {}, payload })
    lastStatus = force?.status ?? response!.statusCode; lastBody = force?.body ?? response!.json()
    if (lost) throw Error('synthetic response lost after admission')
    return new Response(JSON.stringify(lastBody), { status: lastStatus, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const actualRequest = compile('return (' + request.getText(web) + ')', { fetch: fetcher, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED })
  if (quarantine) { db.exec = query => { if (query === 'COMMIT' || query === 'ROLLBACK') throw Error('PRIVATE transaction'); return exec(query) }; assert.throws(() => cfg.updateGroup(g.id, { quantity: 2 }), AggregateError); db.exec = exec }
  return { cfg, db, exec, prepare, target, file, fetcher, actualRequest, stats: () => ({ notifications, syncs, imports, requests, sql, lastStatus, lastBody }), force(value?: typeof force) { force = value }, lose(value: boolean) { lost = value },
    forbidSQL() { db.exec = () => { sql++; assert.fail('new refused request SQL') }; db.prepare = () => { sql++; assert.fail('new refused request prepare') } },
    async close() { db.exec = exec; db.prepare = prepare; if (db.isTransaction) exec('ROLLBACK'); await http.close(); await cfg.close() },
  }
}
async function deleteUI(f: Awaited<ReturnType<typeof fixture>>, expected: RegExp) {
  const page = draftSurface(), editor = draftEditor('point', page.registration()), before = f.stats().requests; page.setAnswer(true)
  try { editor.change('UNSAVED DELETE DRAFT'); await page.deleteDevice(1, url => f.actualRequest(url, { method: 'DELETE' })); assert.match(page.notices.at(-1)!.text, expected); assert.equal(page.state().selectedId, 1); assert.equal(page.drafts.retained().length, 1); assert(page.drafts.retained()[0].snapshot?.text.includes('UNSAVED DELETE DRAFT')); editor.submit(); assert.equal(editor.calls.save, 0, 'old editor stays disabled even for a backend refusal report'); await tick(); assert.equal(f.stats().requests, before + 1) }
  finally { editor.driver.dispose() }
}
async function importUI(f: Awaited<ReturnType<typeof fixture>>, outcome: 'uncertain', reported = false) {
  let result: PointBookResult | undefined, refreshes = 0, successes = 0; const before = f.stats().requests
  const callback = compile('return (' + importCallback.initializer!.getText(web) + ')', { device: f.target, operation: { async run(action: () => Promise<void>) { try { await action(); successes++ } catch {} } }, setBookResult(value: PointBookResult) { result = value }, sendPointBook: (id: number, file: Blob) => uploadPointBook(id, file, f.fetcher), InvalidPointBookReportError, pointBookReportKind, t: (key: string) => key, onRefresh() { refreshes++ }, bookInputRef: { current: { value: 'synthetic.xlsx' } } })
  await callback({ target: { files: [f.file] } }); assert(result); assert.equal(pointBookReportKind(result.report), outcome); assert.equal(successes, 0)
  const html = renderToStaticMarkup(createElement(PointBookImportResult, { result, t: key => key, onDismiss() { assert.fail('no automatic dismissal') } })); assert(html.includes('data-import-outcome="' + outcome + '"'))
  assert.equal(result.report, null); assert(html.includes('pointBookUncertainHint')); assert(!html.includes('pointBookCounts')); assert(!html.includes('本次导入未执行')); assert.equal(refreshes, 0)
  if (reported) assert.match(html, /后台报告写入受阻.*结果待核实/)
  await tick(); assert.equal(f.stats().requests, before + 1)
}
async function check(name: string, action: () => Promise<void>) { try { await action(); passed.push(name); console.log('DESTRUCTIVE OUTCOME OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('DESTRUCTIVE OUTCOME REPRO: ' + failures.at(-1)) } }
process.on('unhandledRejection', collect)
try {
  await check('quarantined-device-deletion-keeps-readonly-records', async () => { const f = await fixture(); try { const before = f.stats(); f.forbidSQL(); await deleteUI(f, /后台报告写入受阻.*结果待核实/); assert.equal(f.stats().lastStatus, 503); assert.equal(f.stats().lastBody.code, 'CONFIG_WRITE_NOT_STARTED'); assert.equal(f.stats().sql, 0); assert.equal(f.stats().syncs, 0); assert.equal(f.stats().notifications, before.notifications) } finally { await f.close() } })
  await check('quarantined-replacement-import-reports-unverified-outcome-before-sink', async () => { const f = await fixture(); try { f.forbidSQL(); await importUI(f, 'uncertain', true); assert.equal(f.stats().imports, 0); assert.equal(f.stats().sql, 0); assert.equal(f.stats().lastStatus, 503) } finally { await f.close() } })
  await check('generic-status-bad-receipts-and-response-loss-stay-unknown', async () => { const f = await fixture(); try { for (const [status, body] of [[503, {}], [503, { version: 2, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }], [503, { version: 1, code: 'CONFIG_TRANSACTION_UNCONFIRMED', outcome: 'not-applied' }], [503, { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'unknown' }], [500, { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }]] as const) { f.force({ status, body }); await deleteUI(f, /待核实/); await importUI(f, 'uncertain') }; for (const report of [null, { groups: 1, registers: 1, errors: ['bad'] }, { groups: 0, registers: 0, errors: [] }]) { f.force({ status: 503, body: { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied', report } }); await importUI(f, 'uncertain') }; f.force(); f.lose(true); await deleteUI(f, /待核实/); await importUI(f, 'uncertain') } finally { await f.close() } })
  for (const kind of ['delete', 'import'] as const) await check(kind + '-original-transaction-uncertain-and-next-request-distinct', async () => { for (const acknowledged of [false, true]) { const f = await fixture(false); try { f.db.exec = query => { if (kind === 'delete' ? query.startsWith('RELEASE SAVEPOINT ') : query === 'COMMIT') { if (acknowledged) f.exec(query); throw Error('PRIVATE commit') }; if (query === 'ROLLBACK' || query.startsWith('ROLLBACK TO SAVEPOINT ')) throw Error('PRIVATE rollback'); return f.exec(query) }; if (kind === 'delete') await deleteUI(f, /待核实/); else await importUI(f, 'uncertain'); assert.equal(f.stats().lastStatus, 500); assert.equal(f.stats().lastBody.code, undefined); assert.equal(f.db.isTransaction, !acknowledged); f.db.exec = f.exec; if (f.db.isTransaction) f.exec('ROLLBACK'); if (kind === 'delete') await deleteUI(f, /后台报告写入受阻.*结果待核实/); else await importUI(f, 'uncertain', true) } finally { await f.close() } } })
  await check('conditional-activation-remains-conservatively-unknown', async () => { const f = await fixture(); try { let refreshes = 0; const before = f.stats().requests; await assert.rejects(saveActivation(captureActivation(f.target), 0, (url, body) => f.actualRequest(url, { method: 'PUT', body: JSON.stringify(body) }), () => { refreshes++ }), ActivationUncertainError); assert.equal(f.stats().requests, before + 1); assert.equal(refreshes, 0); assert.equal(f.stats().syncs, 0); assert.equal(f.stats().lastBody.code, undefined) } finally { await f.close() } })
  await tick(); assert.deepEqual(failures, []); assert.deepEqual(unhandled, [])
} finally { process.off('unhandledRejection', collect) }
console.log('DESTRUCTIVE OUTCOME TEST OK: ' + passed.length + ' actual deletion/replacement import/conditional activation route and UI groups; memory and generated XLSX only, no retry, recovery, listeners, real data or hardware')
