import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PointBookImportResult } from '../apps/web/src/PointBookImportResult.tsx'
import { InvalidPointBookReportError, parsePointBookReport, pointBookReportKind, uploadPointBook } from '../apps/web/src/pointbook-result.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { capturePointBookOpening, pointBookOpeningMatches, pointBookReplacementPrompt } from '../apps/web/src/pointbook-confirmation.ts'
import { liveSnapshotComparisonKey } from '../apps/web/src/live-snapshot-comparison.ts'

const report = { groups: 1, registers: 2, errors: [], warnings: ['已提交，但同步通知失败，请勿重复导入。'] }
const html = renderToStaticMarkup(createElement(PointBookImportResult, { result: { fileName: 'mock.xlsx', report }, t: key => key, onDismiss() {} }))
assert.match(html.replace(/<[^>]*>/g, ''), /已提交，但同步通知失败/, 'a completed import warning must not disappear behind a generic success notice')
assert.match(html, /data-import-outcome="completed"/); assert.doesNotMatch(html, /pointBookRejected/)
assert.equal(pointBookReportKind(report), 'completed')
assert.equal(pointBookReportKind({ ...report, groups: 0, registers: 0, errors: ['bad row'] }), 'rejected')
assert.equal(pointBookReportKind({ ...report, errors: ['partial legacy report'] }), 'uncertain')
assert.equal(pointBookReportKind(null), 'uncertain')
assert.deepEqual(parsePointBookReport({ groups: 0, registers: 0, errors: [] }).warnings, [], 'older reports without optional warnings stay compatible')
for (const bad of [null, [], {}, { ...report, groups: -1 }, { ...report, groups: 0.5 }, { ...report, registers: '2' }, { ...report, errors: null }, { ...report, errors: [1] }, { ...report, warnings: null }, { ...report, warnings: [true] }]) assert.throws(() => parsePointBookReport(bad), InvalidPointBookReportError)
const original = Object.freeze({ ...report, warnings: Object.freeze([...report.warnings]), errors: Object.freeze([]) })
const parsed = parsePointBookReport(original)
parsed.warnings.push('local'); assert.equal(original.warnings.length, 1, 'normalizing does not mutate the response')
let dismissed = 0
const render = (result: Parameters<typeof PointBookImportResult>[0]['result']) => renderToStaticMarkup(createElement(PointBookImportResult, { result, t: key => ({ pointBookCounts: '{g} groups / {r} points' }[key] ?? key), onDismiss() { dismissed++ } }))
const unknown = render({ fileName: '<script>.xlsx', report: null, error: '<img onerror="bad">' })
assert.match(unknown, /data-import-outcome="uncertain"/); assert.match(unknown, /pointBookUncertainHint/)
assert.match(unknown, /&lt;script&gt;/); assert.doesNotMatch(unknown, /<script|<img/)
assert.match(render({ fileName: 'bad.xlsx', report: { ...report, groups: 0, registers: 0, errors: ['row 7 invalid'] } }), /pointBookRejected/)
assert.match(render({ fileName: 'ok.xlsx', report }), /1 groups \/ 2 points/)
assert.equal(dismissed, 0, 'rendering never dismisses, retries or changes configuration')
const file = new Blob(['mock workbook']), target = '/api/monitor_objects/2/points/book'
let calls = 0
const mockFetch = (async (url, options) => {
  calls++; assert.equal(url, target); assert.equal(options?.method, 'POST')
  assert.equal((options?.headers as Record<string, string>)['Content-Type'], 'application/octet-stream'); assert.equal(options?.body, file)
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch
assert.deepEqual(await uploadPointBook(2, file, mockFetch), report); assert.equal(calls, 1)
await assert.rejects(uploadPointBook(2, file, (async () => new Response('{broken', { status: 200 })) as typeof fetch), InvalidPointBookReportError)
await assert.rejects(uploadPointBook(2, file, (async () => new Response(JSON.stringify({ error: 'server result unknown' }), { status: 503 })) as typeof fetch), /HTTP 503: server result unknown/)
let failedCalls = 0
await assert.rejects(uploadPointBook(2, file, (async () => { failedCalls++; throw new Error('connection lost') }) as typeof fetch), /connection lost/)
assert.equal(failedCalls, 1, 'uncertain write failures are never automatically retried')

// Real committed/validation reports, using only a fresh in-memory configuration and generated XLSX.
let failNotify = false
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (failNotify) throw new Error('mock notification failure') })
try {
  const source = cfg.createObject('mock source', 'mock.invalid', 502), target = cfg.createObject('mock target', 'mock.invalid', 502)
  const group = cfg.createGroup(source.id, 'mock group', 3, 0, 1)
  cfg.createRegister(group.id, source.id, 'new point', 3, 0, 'uint16')
  const sink = new Sink({ config: cfg })
  const exported = await sink.exportPointSheet(source.id), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(exported.buffer as any)
  workbook.getWorksheet('mock group')!.getCell('B2').value = null // Existing legacy source default produces a real warning.
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  failNotify = true
  const committed = parsePointBookReport(await sink.importPointBook(target.id, buffer))
  failNotify = false
  assert.equal(committed.errors.length, 0); assert.ok(committed.warnings.length >= 2)
  assert.equal(pointBookReportKind(committed), 'completed'); assert.equal(cfg.listRegistersByObject(target.id).length, 1)
  const visible = render({ fileName: 'legacy-mock.xlsx', report: committed })
  for (const warning of committed.warnings) assert.ok(visible.replace(/<[^>]*>/g, '').includes(warning), 'every actual backend warning remains readable')
  const snapshot = JSON.stringify(cfg.listRegistersByObject(target.id))
  workbook.getWorksheet('mock group')!.getCell('B5').value = 'invalid dtype'
  const rejected = parsePointBookReport(await sink.importPointBook(target.id, Buffer.from(await workbook.xlsx.writeBuffer())))
  assert.equal(pointBookReportKind(rejected), 'rejected')
  assert.equal(JSON.stringify(cfg.listRegistersByObject(target.id)), snapshot, 'invalid-file result preserves the mock target configuration')
} finally { (cfg as any).db.close() }
console.log('POINTBOOK RESULT OK: committed warnings vs rejected/uncertain outcomes, exact counts/file/errors, legacy/malformed reports, safe SSR, one-shot mocked upload and real memory-only XLSX notification/default warnings; no real configuration or network')

// Execute the actual page's chooser/change handlers, with a simulated file picker/confirmation.
{
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), tree = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let found: ts.Node | undefined; ts.forEachChild(node, child => { found ??= find(child, predicate) }); return found }
  const variable = (name: string) => (find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration).initializer!
  const current = (find(tree, node => ts.isBinaryExpression(node) && node.left.getText(tree) === 'bookCurrentRef.current') as ts.BinaryExpression).right
  const lifetime = (find(tree, node => ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && !!node.arguments[0]?.getText(tree).includes('bookAlive.current = true')) as ts.CallExpression).arguments[0]
  const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(tree) + ')', { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env))
  assert(app.includes('<LiveTable configurationReady={configurationReady}')); assert(app.includes('disabled={operation.busy || !configurationReady || !snapshotComparisonScope} onClick={chooseBook}'))
  const db = new ConfigStore({ dbPath: ':memory:' }), service = new Sink({ config: db })
  const device = (name: string) => { const d = db.createObject(name, 'mock.invalid', 502), g = db.createGroup(d.id, 'existing', 3, 99, 1), p = db.createRegister(g.id, d.id, 'OLD', 3, 99, 'uint16'); db.createRule(p.id, '>', 1, 'old alarm'); return d }
  const groups = (id: number) => db.listGroups(id).map(group => ({ ...group, registers: db.listRegisters(group.id) }))
  const graph = () => JSON.stringify({ objects: db.listObjects(), groups: db.listObjects().flatMap(d => groups(d.id)), rules: db.listRules(), logs: db.listLogs() })
  try {
    const source = device('WORKBOOK SOURCE'); (db as any).db.prepare('UPDATE registers SET alias = ? WHERE object_id = ?').run('IMPORTED', source.id); const book = await service.exportPointSheet(source.id), blob = Object.assign(new Blob([new Uint8Array(book.buffer)]), { name: 'synthetic-target.xlsx' })
    function host(initial = device('TARGET')) {
      const notices: unknown[] = [], prompts: string[] = [], errors: unknown[] = []; let result: unknown, posts = 0, clicks = 0, refreshes = 0, answer = false, onConfirm: (() => void) | null = null, lost = false
      const input = { value: '', files: [] as Blob[], click() { clicks++ } }, refs = { bookInputRef: { current: input }, bookOpeningRef: { current: null as ReturnType<typeof capturePointBookOpening> }, bookAlive: { current: true }, bookCurrentRef: { current: () => null as ReturnType<typeof capturePointBookOpening> } }
      const operation = { busy: false, setNotice(value: unknown) { notices.push(value) }, async run(action: () => Promise<void>) { if (operation.busy) return; operation.busy = true; try { await action() } catch (error) { errors.push(error) } finally { operation.busy = false } } }
      const env: Record<string, any> = { ...refs, operation, device: initial, groups: groups(initial.id), configurationReady: true, snapshotComparisonScope: Symbol('local'), liveSnapshotComparisonKey, capturePointBookOpening, pointBookOpeningMatches, pointBookReplacementPrompt, t: (key: string) => key === 'cancel' ? '取消' : key, setBookResult(value: unknown) { result = value }, onRefresh() { refreshes++ }, InvalidPointBookReportError, pointBookReportKind,
        sendPointBook: (id: number, file: Blob) => uploadPointBook(id, file, async (url, options) => { posts++; assert.equal(url, '/api/monitor_objects/' + id + '/points/book'); assert.equal(options?.body, file); const report = await service.importPointBook(id, Buffer.from(await file.arrayBuffer()), true); if (lost) throw Error('synthetic lost committed response'); return new Response(JSON.stringify(report)) }),
        window: { confirm(message: string) { prompts.push(message); onConfirm?.(); return answer } } }
      let choose!: () => void, upload!: (event: unknown) => Promise<void>, previousKey: string | null = null
      function render(next: Record<string, unknown> = {}) { Object.assign(env, next); const key = liveSnapshotComparisonKey(env.device, env.groups); if (key !== previousKey) { env.snapshotComparisonScope = key ? Symbol('local') : null; previousKey = key }; refs.bookCurrentRef.current = evaluate(current, env); choose = evaluate(variable('chooseBook'), env); upload = evaluate(variable('uploadBook'), env) }
      render(); const cleanup = evaluate(lifetime, env)()
      return { env, refs, input, notices, prompts, errors, render, choose() { choose() }, async select(file: Blob | null = blob) { input.files = file ? [file] : []; input.value = 'selected'; await upload({ target: input }) }, setAnswer(value: boolean) { answer = value }, duringConfirm(fn: () => void) { onConfirm = fn }, loseResponse() { lost = true }, dispose: cleanup, stats: () => ({ posts, clicks, refreshes, result }) }
    }
    const cancelled = host(), beforeCancel = graph(); cancelled.choose(); await cancelled.select(); assert.equal(cancelled.stats().posts, 0); assert.equal(graph(), beforeCancel); assert.equal(cancelled.input.value, '')
    assert(cancelled.prompts[0].includes('不是追加') && cancelled.prompts[0].includes('后台未同步') && cancelled.prompts[0].includes('不是文件内容预览') && cancelled.prompts[0].includes('synthetic-target.xlsx')); cancelled.dispose()
    const noFile = host(); noFile.choose(); await noFile.select(null); assert.equal(noFile.stats().posts, 0); assert.equal(noFile.prompts.length, 0); assert.equal(noFile.refs.bookOpeningRef.current, null); noFile.dispose()
    const busy = host(); busy.env.operation.busy = true; busy.choose(); assert.equal(busy.stats().clicks, 0); assert.equal(busy.refs.bookOpeningRef.current, null); busy.dispose()
    const english = pointBookReplacementPrompt(blob.name, source, groups(source.id), true); assert(english.includes('not append') && english.includes('not a file-content preview') && english.includes('Unsynchronized'))
    for (const kind of ['device', 'connection', 'points', 'unverified', 'aba', 'during-confirm', 'unmount']) {
      const h = host(); h.choose(); const before = graph(); h.setAnswer(true)
      if (kind === 'device') { const other = device('OTHER'); h.render({ device: other, groups: groups(other.id) }) }
      if (kind === 'connection') h.render({ device: { ...h.env.device, ip: 'changed.mock.invalid' } })
      if (kind === 'points') h.render({ groups: h.env.groups.map((g: any) => ({ ...g, registers: g.registers.map((p: any) => ({ ...p, alias: 'changed' })) })) })
      if (kind === 'unverified') h.render({ configurationReady: false })
      if (kind === 'aba') { const original = h.env.device; h.render({ device: { ...original, ip: 'B.mock.invalid' } }); h.render({ device: original }) }
      if (kind === 'during-confirm') h.duringConfirm(() => h.render({ device: { ...h.env.device, ip: 'during.mock.invalid' } }))
      if (kind === 'unmount') h.dispose()
      const afterFixtureSetup = graph(); await h.select(); assert.equal(h.stats().posts, 0); assert.equal(graph(), afterFixtureSetup); if (kind !== 'device') assert.equal(graph(), before); assert.equal(h.prompts.length, kind === 'during-confirm' ? 1 : 0); if (kind !== 'unmount') h.dispose()
    }
    const accepted = host(), targetId = accepted.env.device.id, oldPoint = accepted.env.groups[0].registers[0].id; accepted.setAnswer(true); accepted.choose(); await accepted.select(); assert.equal(accepted.stats().posts, 1); assert(!db.listRegistersByObject(targetId).some(point => point.alias === 'OLD')); assert(db.listRegistersByObject(targetId).every(point => point.alias === 'IMPORTED')); assert.equal(groups(targetId).length, 1); await accepted.select(); assert.equal(accepted.stats().posts, 1); accepted.dispose()
    const unsynced = host(), ug = unsynced.env.groups[0]; let addedId = 0; unsynced.duringConfirm(() => { const remoteGroup = db.createGroup(unsynced.env.device.id, 'REMOTE GROUP NOT IN PAGE', 3, 100, 1); addedId = db.createRegister(remoteGroup.id, unsynced.env.device.id, 'REMOTE EDIT NOT IN PAGE', 3, 100, 'uint16').id }); unsynced.setAnswer(true); unsynced.choose(); await unsynced.select(); assert.equal(unsynced.stats().posts, 1); assert.equal(db.getRegister(addedId), undefined, 'known boundary: old unconditional REST still replaces unseen background edits'); unsynced.dispose()
    const unknown = host(); unknown.loseResponse(); unknown.setAnswer(true); unknown.choose(); await unknown.select(); assert.equal(unknown.stats().posts, 1); assert.equal((unknown.stats().result as any).report, null); await unknown.select(); assert.equal(unknown.stats().posts, 1); unknown.dispose()
    console.log('POINTBOOK CONFIRMATION OK: cancel; replacement/append contract; 7 changed/old-selection cases; confirmed exact target; unseen-backend-change boundary; committed response loss stays single-use; synthetic memory only.')
  } finally { (db as any).db.close() }
}
