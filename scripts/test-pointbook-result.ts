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
import { hookDriver } from './fixtures/component-hook-driver.ts'

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

// Read the real bilingual dictionary without importing App or starting its runtime.
{
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const dictionary = tree.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find(declaration => declaration.name.getText(tree) === 'I18N')!.initializer!
  const labels = new Function('return (' + dictionary.getText(tree) + ')')() as Record<'zh' | 'en', Record<string, string>>
  for (const language of ['zh', 'en'] as const) {
    const show = (value: Parameters<typeof PointBookImportResult>[0]['result']) => {
      const markup = renderToStaticMarkup(createElement(PointBookImportResult, { result: value, t: key => { assert.equal(typeof labels[language][key], 'string', 'missing ' + language + ' translation: ' + key); return labels[language][key] }, onDismiss() { dismissed++ } }))
      return { markup, text: markup.replace(/<[^>]*>/g, '') }
    }
    const clean = show({ fileName: 'clean.xlsx', report: { groups: 1, registers: 2, errors: [], warnings: [] } })
    const warned = show({ fileName: 'defaults.xlsx', report }), refused = show({ fileName: 'invalid.xlsx', report: { groups: 0, registers: 0, errors: ['row 7: invalid dtype'], warnings: [] } })
    const lost = show({ fileName: 'lost.xlsx', report: null, error: 'response lost' }), contradictory = show({ fileName: 'legacy.xlsx', report: { groups: 1, registers: 2, errors: ['legacy partial report'], warnings: [] } })
    assert.match(clean.markup, /data-import-outcome="completed"/); assert.match(clean.markup, /role="status"/)
    assert.match(warned.markup, /data-import-outcome="completed"/); assert(warned.text.includes(report.warnings[0])); assert.match(refused.markup, /data-import-outcome="rejected"/)
    for (const value of [lost, contradictory]) { assert.match(value.markup, /data-import-outcome="uncertain"/); assert.match(value.markup, /role="alert"/) }
    const phrases = language === 'zh'
      ? { clean: ['从站/地址/类型/倍率', '告警规则', '不表示设备通信或采样已验证'], warned: ['逐条核对', '不要仅为消除提示重复导入'], refused: ['错误详情', '源文件', '当前配置'], uncertain: ['不要直接重复导入', '分组、点位和告警规则'], counts: '服务端回报' }
      : { clean: ['slave/address/type/scale', 'alarm rules', 'does not verify device communication or sampling'], warned: ['Review each item', 'Do not re-import just to clear warnings'], refused: ['error details', 'source file', 'current configuration'], uncertain: ['Do not import again immediately', 'groups, points and alarm rules'], counts: 'Server report' }
    for (const phrase of phrases.clean) assert(clean.text.includes(phrase), language + ' success must explain what remains to verify: ' + phrase)
    for (const phrase of phrases.warned) assert(warned.text.includes(phrase), language + ' warning guidance: ' + phrase)
    for (const phrase of phrases.refused) assert(refused.text.includes(phrase), language + ' rejection guidance: ' + phrase)
    for (const value of [lost, contradictory]) for (const phrase of phrases.uncertain) assert(value.text.includes(phrase), language + ' unknown guidance: ' + phrase)
    for (const value of [clean, warned, refused, contradictory]) assert(value.text.includes(phrases.counts), 'counts must remain attributed to the response, including contradictory reports')
    assert(!lost.text.includes(phrases.counts), 'no response must not invent zero counts'); assert(refused.text.includes('row 7: invalid dtype'))
    const recorded = show({ fileName: 'old-target.xlsx', targetLabel: '<old-target> (#7) · TCP old.mock.invalid:502', report: null, error: 'lost' })
    assert(recorded.text.includes(labels[language].pointBookTargetSnapshot)); assert(recorded.markup.includes('&lt;old-target&gt;')); assert(!recorded.markup.includes('<old-target>'))
    const paged = show({ fileName: 'large.xlsx', report: { ...report, errors: Array(21).fill('error'), warnings: Array(21).fill('warning') } })
    assert(paged.text.includes(labels[language].pointBookPagingHint)); assert.equal((paged.markup.match(/<li>/g) ?? []).length, 40)
    const ids = [...paged.markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length, 'real SSR uses unique IDs across error and warning controls')
  }
  assert.equal(dismissed, 0, 'rendering guidance does not dismiss, retry or mutate anything')
  console.log('POINTBOOK GUIDANCE OK: actual zh/en labels for clean completion, committed warning, rejection, response loss and contradictory legacy counts; presentation only.')
}

// Simulated native control callbacks, not browser keyboard/focus/layout automation.
{
  const messages = Object.freeze(Array.from({ length: 250 }, (_, i) => 'item-' + i + '\n' + '<long detail>'.repeat(20)))
  const t = (key: string) => ({ pointBookPage: 'Page', pointBookPrevious: 'Previous', pointBookNext: 'Next', pointBookMessageRange: '{start}-{end}/{total}, {page}/{pages}', pointBookPagingHint: 'All received entries retained; paging display only.' }[key] ?? key)
  const props = { title: 'Warnings', messages, t }, h = hookDriver('PointBookImportResult.tsx', 'PointBookMessages', {}, props)
  const rows = () => (h.one('ul').props.children as any[]).map(row => row.props.children as string)
  const jump = (value: string) => { h.one('input').props.onChange({ currentTarget: { value } }); h.render() }
  const seen: string[] = []
  for (let page = 1; page <= 13; page++) { jump(String(page)); assert(rows().length <= 20); seen.push(...rows()) }
  assert.deepEqual(seen, [...messages], 'all long messages remain reachable in original order, without trimming')
  assert.equal(h.one('input').props.value, 13); assert.equal(h.one('button', p => p.children === 'Next').props.disabled, true)
  const list = h.one('ul'), input = h.one('input'), label = h.one('label'), nav = h.one('nav')
  assert.equal(list.props.tabIndex, 0); assert.equal(input.props.type, 'number'); assert.equal(input.props.min, 1); assert.equal(input.props.max, 13)
  assert.equal(input.props['aria-controls'], list.props.id); assert.equal(label.props.htmlFor, input.props.id); assert(nav.props['aria-label'].includes('Warnings'))
  assert.equal(h.one('button', p => p.children === 'Previous').props.type, 'button'); assert.equal(h.one('button', p => p.children === 'Next').props.type, 'button')
  assert.equal(list.props.onKeyDown, undefined); assert.equal(input.props.onKeyDown, undefined, 'native key behavior is not intercepted')
  for (const invalid of ['', ' ', '0', '14', '-1', '1.2', 'NaN', 'Infinity', '9007199254740992']) { jump(invalid); assert.equal(h.one('input').props.value, 13) }
  jump('2'); h.one('button', p => p.children === 'Previous').props.onClick(); h.render(); assert.equal(h.one('input').props.value, 1)
  h.one('button', p => p.children === 'Next').props.onClick(); h.render(); assert.equal(h.one('input').props.value, 2)
  const replacement = { ...props, messages: Object.freeze(['new report only']) }; h.render(replacement); assert.deepEqual(rows(), ['new report only']); h.render(); assert.deepEqual(rows(), ['new report only'])
  h.render(props); assert.equal(h.one('input').props.value, 1, 'new report then old array does not revive an old page'); h.dispose()
  const errorProps = { title: 'Errors', messages: Object.freeze(Array.from({ length: 20 }, (_, i) => 'error-' + i)), extra: 'response detail', t }, errors = hookDriver('PointBookImportResult.tsx', 'PointBookMessages', {}, errorProps)
  errors.one('input').props.onChange({ currentTarget: { value: '2' } }); errors.render(); assert.deepEqual((errors.one('ul').props.children as any[]).map(row => row.props.children), ['response detail'])
  errors.render({ ...errorProps, extra: 'different response detail' }); assert.equal(errors.one('input').props.value, 1); errors.dispose()
  assert.deepEqual(messages[249], 'item-249\n' + '<long detail>'.repeat(20)); assert.equal(dismissed, 0)
  console.log('POINTBOOK PAGING OK: every long message reachable, first/last/next/previous/jump/invalid input, report/extra ownership reset, native controls and unique SSR label targets; no browser focus/layout claim.')
}
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

// Response/body failures are not rollback receipts. Optional warnings remain legacy-compatible.
{
  const cases: { name: string; status?: number; body?: unknown; raw?: string; disconnected?: boolean; expected: string }[] = [
    { name: 'missing counts', body: { errors: [], warnings: [] }, expected: 'uncertain' },
    { name: 'missing errors', body: { groups: 1, registers: 2, warnings: [] }, expected: 'uncertain' },
    { name: 'invalid warnings', body: { ...report, warnings: ['first', null] }, expected: 'uncertain' },
    { name: 'truncated warning JSON', raw: '{"groups":1,"registers":2,"errors":[],"warnings":["first","last', expected: 'uncertain' },
    { name: 'contradictory partial report', body: { ...report, errors: ['partial legacy report'] }, expected: 'uncertain' },
    { name: 'refusal report', body: { groups: 0, registers: 0, errors: ['invalid row'], warnings: [] }, expected: 'rejected' },
    { name: 'non-success status with success-shaped body', status: 503, body: report, expected: 'uncertain' },
    { name: 'disconnect', disconnected: true, expected: 'uncertain' },
    { name: 'legacy optional warnings absent', body: { groups: 1, registers: 2, errors: [] }, expected: 'completed' }
  ]
  for (const item of cases) {
    let requests = 0, result: Parameters<typeof PointBookImportResult>[0]['result'] = { fileName: item.name, report: null }
    try { result.report = await uploadPointBook(2, file, (async () => { requests++; if (item.disconnected) throw Error('synthetic disconnect'); return new Response(item.raw ?? JSON.stringify(item.body), { status: item.status ?? 200 }) }) as typeof fetch) }
    catch (error) { result.error = error instanceof Error ? error.message : String(error) }
    assert.equal(requests, 1, item.name + ' never retries'); assert.equal(pointBookReportKind(result.report), item.expected)
    const visible = render(result); assert(visible.includes('data-import-outcome="' + item.expected + '"')); if (item.expected !== 'completed') assert(!visible.includes('pointBookCompleted'))
    assert(!visible.includes('已回滚') && !visible.includes('rolled back'), 'unknown/refusal reports must not invent rollback')
  }
  const warnings = Array.from({ length: 250 }, (_, i) => 'warning-' + i + ': ' + 'long <unsafe> detail '.repeat(40) + 'END-' + i)
  const normalized = await uploadPointBook(2, file, (async () => new Response(JSON.stringify({ ...report, warnings }))) as typeof fetch)
  assert.deepEqual(normalized.warnings, warnings); const visible = render({ fileName: 'long-warnings.xlsx', report: normalized })
  assert.equal((visible.match(/<li>/g) ?? []).length, 20, 'large warning lists must bound initial rendering without truncating the retained response'); assert(visible.includes('END-0') && visible.includes('END-19')); assert(!visible.includes('END-249')); assert(visible.includes('tabindex="0"')); assert(!visible.includes('<unsafe>'))
  console.log('POINTBOOK RESPONSE MATRIX OK: 9 malformed/contradictory/status/disconnect/legacy cases, 250 long warnings retained without client truncation; no rollback or retry claim.')
}

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
    const secondSource = device('SECOND WORKBOOK'); (db as any).db.prepare('UPDATE registers SET alias = ? WHERE object_id = ?').run('SECOND FILE', secondSource.id); const secondBook = await service.exportPointSheet(secondSource.id), secondBlob = Object.assign(new Blob([new Uint8Array(secondBook.buffer)]), { name: 'synthetic-second.xlsx' })
    function host(initial = device('TARGET')) {
      const notices: unknown[] = [], prompts: string[] = [], errors: unknown[] = [], sentFiles: Blob[] = []; let result: unknown, posts = 0, clicks = 0, refreshes = 0, answer = false, onConfirm: (() => void) | null = null, lost = false, replyGate: Promise<void> | null = null
      const input = { value: '', files: [] as Blob[], click() { clicks++ } }, refs = { bookInputRef: { current: input }, bookOpeningRef: { current: null as ReturnType<typeof capturePointBookOpening> }, bookAlive: { current: true }, bookCurrentRef: { current: () => null as ReturnType<typeof capturePointBookOpening> } }
      const operation = { busy: false, setNotice(value: unknown) { notices.push(value) }, async run(action: () => Promise<void>) { if (operation.busy) return; operation.busy = true; try { await action() } catch (error) { errors.push(error) } finally { operation.busy = false } } }
      const env: Record<string, any> = { ...refs, operation, device: initial, groups: groups(initial.id), configurationReady: true, snapshotComparisonScope: Symbol('local'), liveSnapshotComparisonKey, capturePointBookOpening, pointBookOpeningMatches, pointBookReplacementPrompt, t: (key: string) => key === 'cancel' ? '取消' : key, setBookResult(value: unknown) { result = value }, onRefresh() { refreshes++ }, InvalidPointBookReportError, pointBookReportKind,
        sendPointBook: (id: number, file: Blob) => uploadPointBook(id, file, async (url, options) => { posts++; sentFiles.push(file); assert.equal(url, '/api/monitor_objects/' + id + '/points/book'); assert.equal(options?.body, file); const report = await service.importPointBook(id, Buffer.from(await file.arrayBuffer()), true); await replyGate; if (lost) throw Error('synthetic lost committed response'); return new Response(JSON.stringify(report)) }),
        window: { confirm(message: string) { prompts.push(message); onConfirm?.(); return answer } } }
      let choose!: () => void, upload!: (event: unknown) => Promise<void>, previousKey: string | null = null
      function render(next: Record<string, unknown> = {}) { Object.assign(env, next); const key = liveSnapshotComparisonKey(env.device, env.groups); if (key !== previousKey) { env.snapshotComparisonScope = key ? Symbol('local') : null; previousKey = key }; refs.bookCurrentRef.current = evaluate(current, env); choose = evaluate(variable('chooseBook'), env); upload = evaluate(variable('uploadBook'), env) }
      render(); const cleanup = evaluate(lifetime, env)()
      return { env, refs, input, notices, prompts, errors, sentFiles, render, choose() { choose() }, async select(file: Blob | null = blob) { input.files = file ? [file] : []; input.value = 'selected'; await upload({ target: input }) }, setAnswer(value: boolean) { answer = value }, duringConfirm(fn: () => void) { onConfirm = fn }, loseResponse() { lost = true }, holdReply() { let release!: () => void; replyGate = new Promise<void>(resolve => { release = resolve }); return release }, dispose: cleanup, stats: () => ({ posts, clicks, refreshes, result }) }
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
    const replacement = host(); replacement.choose(); await replacement.select(blob); assert.equal(replacement.stats().posts, 0)
    replacement.choose(); replacement.choose(); replacement.setAnswer(true); await replacement.select(secondBlob)
    assert.equal(replacement.prompts.length, 2); assert(replacement.prompts[0].includes(blob.name)); assert(replacement.prompts[1].includes(secondBlob.name)); assert.equal(replacement.sentFiles[0], secondBlob)
    assert(db.listRegistersByObject(replacement.env.device.id).every(point => point.alias === 'SECOND FILE')); assert.equal(replacement.stats().posts, 1); replacement.dispose()
    const captured = host(); captured.setAnswer(true); captured.choose(); captured.duringConfirm(() => { captured.input.files = [secondBlob] }); await captured.select(blob)
    assert.equal(captured.sentFiles[0], blob, 'a later input FileList must not substitute file B under file A confirmation'); assert(captured.prompts[0].includes(blob.name)); assert(!captured.prompts[0].includes(secondBlob.name)); captured.dispose()
    const pending = host(), release = pending.holdReply(); pending.setAnswer(true); pending.loseResponse(); pending.choose(); const request = pending.select(blob)
    assert.equal(pending.stats().posts, 1); const clicks = pending.stats().clicks; pending.choose(); await pending.select(secondBlob)
    assert.equal(pending.stats().clicks, clicks); assert.equal(pending.stats().posts, 1); assert.equal(pending.prompts.length, 1); assert.equal(pending.env.operation.busy, true)
    release(); await request; assert.equal((pending.stats().result as any).report, null); assert.equal(pending.env.operation.busy, false); assert.equal(pending.stats().posts, 1)
    assert(db.listRegistersByObject(pending.env.device.id).every(point => point.alias === 'IMPORTED'), 'unknown response does not imply rollback')
    pending.setAnswer(false); pending.choose(); await pending.select(secondBlob); assert.equal(pending.prompts.length, 2); assert(pending.prompts[1].includes(secondBlob.name)); assert.equal(pending.stats().posts, 1); pending.dispose()
    const departed = host(), releaseOld = departed.holdReply(), oldTarget = departed.env.device.id; departed.setAnswer(true); departed.loseResponse(); departed.choose(); const oldRequest = departed.select(blob); departed.dispose()
    const newPage = host(), beforeNew = JSON.stringify(groups(newPage.env.device.id)); releaseOld(); await oldRequest
    assert(db.listRegistersByObject(oldTarget).every(point => point.alias === 'IMPORTED'), 'leaving does not undo an admitted import'); assert.equal(newPage.stats().result, undefined); assert.equal(newPage.stats().posts, 0); assert.equal(JSON.stringify(groups(newPage.env.device.id)), beforeNew); newPage.dispose()
    for (const prompt of [...pending.prompts, ...replacement.prompts]) { assert(prompt.includes('后台未同步') && prompt.includes('仍可能被替换')); assert(!prompt.includes('已锁定')) }
    assert(app.includes('key={selected.id}'), 'actual device-ID selection remounts DeviceView; same-ID edits do not')
    for (const transport of ['tcp', 'rtu']) for (const disconnected of [false, true]) {
      const target = device('INITIATING ' + transport.toUpperCase()), changed = host({ ...target, transport, serialPath: transport === 'rtu' ? 'COM-MOCK' : null }), original = { ...changed.env.device }, releaseResult = changed.holdReply(); changed.setAnswer(true); if (disconnected) changed.loseResponse(); changed.choose(); const inFlight = changed.select(blob)
      changed.render({ device: { ...original, name: 'REPLACED PAGE NAME', ip: 'new-page.mock.invalid' } }); releaseResult(); await inFlight
      const result = changed.stats().result as Parameters<typeof PointBookImportResult>[0]['result']
      assert.equal(changed.stats().posts, 1); assert.equal(pointBookReportKind(result.report), disconnected ? 'uncertain' : 'completed')
      assert(result.targetLabel?.includes(original.name) && result.targetLabel.includes('#' + original.id) && result.targetLabel.includes(transport === 'rtu' ? original.serialPath : original.ip + ':' + original.port), 'late result must identify its initiating page target, not imply the current same-ID source was verified')
      const visible = render(result); assert(visible.includes(original.name)); assert(!visible.includes('REPLACED PAGE NAME') && !visible.includes('new-page.mock.invalid')); assert(visible.includes('pointBookTargetSnapshot')); changed.dispose()
    }
    console.log('POINTBOOK RESULT TARGET OK: same-ID page target edits during successful/lost replies retain initiating target metadata; different-ID remount boundary retained.')
    console.log('POINTBOOK COMBINATION OK: cancel then different file, captured file identity, pending duplicate/unknown outcome, admitted old-owner completion; no backend-lock or rollback claim.')
    console.log('POINTBOOK CONFIRMATION OK: cancel; replacement/append contract; 7 changed/old-selection cases; confirmed exact target; unseen-backend-change boundary; committed response loss stays single-use; synthetic memory only.')
  } finally { (db as any).db.close() }
}
