import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sink } from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { withRegisterSources } from '../packages/core/src/sample-source.ts'
import { historyReadContextKey } from '../apps/web/src/history-read-context.ts'
import { queryMemoryContext } from '../apps/web/src/history-query-memory.ts'
import { captureHistoryExport, downloadHistoryExport, historyExportContextMatches, historyExportUrl, HistoryExportContextChangedError, type HistoryExportContext } from '../apps/web/src/history-export.ts'
import { HistoryExportModal } from '../apps/web/src/HistoryExportModal.tsx'

// Only reviewed source fragments are evaluated; App and its effects are never mounted.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(root: ts.Node, matches: (node: ts.Node) => boolean): ts.Node | undefined { if (matches(root)) return root; return ts.forEachChild(root, node => find(node, matches)) }
const evaluate = (node: ts.Node, names: string[], values: unknown[]) => new Function(...names, ts.transpileModule('const result = ' + node.getText(source) + '; return result', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...values)
const view = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HistoryView')!
const declaration = (name: string) => find(view, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration
const contextDeclaration = declaration('exportContext'), capture = find(view, node => ts.isCallExpression(node) && node.expression.getText(source) === 'captureHistoryExport')!
const liveAssignment = find(view, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'exportContextRef.current' && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)!
const modal = find(view, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'HistoryExportModal') as ts.JsxSelfClosingElement
const prop = (name: string) => ((modal.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === name) as ts.JsxAttribute).initializer as ts.JsxExpression).expression!
assert(contextDeclaration?.initializer && capture && liveAssignment && prop('contextCurrent') && prop('onPick'))
const messagesNode = (find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!
assert(!find(messagesNode, ts.isCallExpression)); const messages = evaluate(messagesNode, [], [])

const time = Date.parse('2026-11-07T00:00:00.123Z'), device = { id: 7, mode: 'master', transport: 'tcp', ip: 'mock.invalid', port: 502, slaveId: 1 }
const group = { id: 10, objectId: 7, name: 'mock', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 2 }
const point = { id: 101, objectId: 7, groupId: 10, alias: 'opening', functionCode: 3, startAddress: 0, dataType: 'uint16', factor: 1, offset: 0, unit: null, enumJson: null, decimalPlaces: null }
let points = [point], ready = true
function current(): HistoryExportContext | null {
  const rows = withRegisterSources(points, [group], device)
  return evaluate(contextDeclaration.initializer!, ['useMemo', 'configurationReady', 'contextKey', 'memoryContext'], [(fn: () => unknown) => fn(), ready, historyReadContextKey(device, [group], rows), queryMemoryContext(device, rows)])
}
const opening = current()!, request = evaluate(capture, ['captureHistoryExport', 'device', 'exportRange', 'selectedRegisters', 'localTzOffsetMin', 'scope', 'exportContext'], [captureHistoryExport, device, { start: time, end: time + 1000 }, [point], () => 0, 'full', opening]) as ReturnType<typeof captureHistoryExport>
assert(Object.isFrozen(request.context)); assert.notEqual(request.context, opening); assert(historyExportContextMatches(request, current()))
;(opening as { definitions: string }).definitions = 'later mutation of caller object'; assert(historyExportContextMatches(request, current()), 'capture keeps an independent context projection')
assert(!historyExportUrl('csv', request).includes('context')); assert(!historyExportUrl('csv', request).includes('mock.invalid'))
for (const invalid of [null, {}, { definitions: '', device: 'x' }, { definitions: 'x', device: 2 }]) assert.throws(() => captureHistoryExport(7, { start: time, end: time + 1000 }, [101], 0, 'full', invalid as any), HistoryExportContextChangedError)

const data = [{ objectId: 7, area: 'holding-register', address: 0, slaveId: 1, rawValue: 123, quality: 'good', timestampMs: time, ts: new Date(time).toISOString(), batchId: 'first' }, ...[1, 0].map((rawValue, address) => ({ objectId: 7, area: 'holding-register', address, slaveId: 2, rawValue, quality: 'good', timestampMs: time, ts: new Date(time).toISOString(), batchId: 'second' }))]
const sink = new Sink({ config: { listRegistersByObject: () => points, listGroups: () => [group], getObject: () => device }, store: { async queryObjectForExport(_id: number, _start: string, _end: string, ranges: any[]) { return data.filter(row => ranges.some(range => range.area === row.area && range.slaveId === row.slaveId && row.address >= range.startAddress && row.address <= range.endAddress)) } } })
const app = Fastify(); registerHistoryExport(app, sink)
let reads = 0, saves: Array<{ blob: Blob; request: unknown }> = []
const adapter: typeof fetch = async (url, init) => { reads++; assert(init?.signal instanceof AbortSignal); const response = await app.inject(String(url)); return new Response(response.rawPayload as any, { status: response.statusCode, headers: response.headers as any }) }
let fetcher = adapter
const live = { current: current() }
const update = () => evaluate(liveAssignment, ['exportContextRef', 'exportContext'], [live, current()])
const onPick = evaluate(prop('onPick'), ['downloadHistoryExport', 'exportRequest', 'exportContextRef'], [(format: 'csv' | 'xlsx', captured: typeof request, signal: AbortSignal, latest: () => HistoryExportContext | null) => downloadHistoryExport(format, captured, signal, latest, (...args) => fetcher(...args), (blob, _format, saved) => { saves.push({ blob, request: saved }) }), request, live]) as (format: 'csv' | 'xlsx', signal: AbortSignal) => Promise<void>
const isCurrent = () => evaluate(prop('contextCurrent'), ['historyExportContextMatches', 'exportRequest', 'exportContext'], [historyExportContextMatches, request, current()])
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
try {
  await onPick('csv', new AbortController().signal); assert.equal(reads, 1); assert.equal(saves.length, 1); assert.equal(saves[0].request, request); assert((await saves[0].blob.text()).includes('123')); saves = []
  points = []; update(); assert.equal(isCurrent(), false)
  // Confirm the original legacy mismatch remains possible, without changing its contract.
  const old = await app.inject(historyExportUrl('csv', request)); assert.equal(old.statusCode, 200); assert.equal(old.body.split('\n')[0].split(',').length, 1)
  for (const format of ['csv', 'xlsx'] as const) await assert.rejects(onPick(format, new AbortController().signal), HistoryExportContextChangedError)
  assert.equal(reads, 1, 'observed deletion blocks before starting a download'); assert.equal(saves.length, 0)
  points = [point]; ready = false; update(); await assert.rejects(onPick('csv', new AbortController().signal), HistoryExportContextChangedError); assert.equal(reads, 1)
  ready = true; device.ip = 'other.mock.invalid'; update(); await assert.rejects(onPick('csv', new AbortController().signal), HistoryExportContextChangedError); device.ip = 'mock.invalid'; update()
  const entered = deferred<void>(), response = deferred<Response>()
  fetcher = async () => { entered.resolve(); return response.promise }
  const pending = onPick('csv', new AbortController().signal); await entered.promise
  group.slaveId = 2; point.dataType = 'uint32'; point.alias = 'changed'; update()
  response.resolve(new Response('timestamp,changed\nnow,65536', { headers: { 'content-type': 'text/csv' } }))
  await assert.rejects(pending, HistoryExportContextChangedError); assert.equal(saves.length, 0, 'late successful response is not downloaded under changed definitions')
  group.slaveId = 1; point.dataType = 'uint16'; point.alias = 'opening'; update()
  const bodyEntered = deferred<void>(), body = deferred<Blob>()
  fetcher = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/csv' }), blob: () => { bodyEntered.resolve(); return body.promise } } as Response)
  const waitingBody = onPick('csv', new AbortController().signal); await bodyEntered.promise; ready = false; update(); body.resolve(new Blob(['old response']))
  await assert.rejects(waitingBody, HistoryExportContextChangedError); assert.equal(saves.length, 0, 'check after body resolution, not just after headers')
  ready = true; group.slaveId = 2; point.dataType = 'uint32'; update()
  const reopened = captureHistoryExport(7, { start: time, end: time + 1000 }, [101], 0, 'full', current()!)
  await downloadHistoryExport('xlsx', reopened, new AbortController().signal, current, adapter, (blob, _format, captured) => { saves.push({ blob, request: captured }) }); assert.equal(saves.length, 1); assert.equal(saves[0].request, reopened)
  const canceled = new AbortController(); canceled.abort(); const before = reads
  await assert.rejects(downloadHistoryExport('csv', reopened, canceled.signal, current, adapter)); assert.equal(reads, before)
} finally { await app.close() }

let callbacks = 0
for (const lang of ['zh', 'en']) {
  const t = (key: string) => messages[lang][key] ?? key
  const html = renderToStaticMarkup(createElement(HistoryExportModal, { request, contextCurrent: false, t, onClose() { callbacks++ }, async onPick() { callbacks++ } }))
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2); assert(html.includes('role="alert"')); assert(html.includes(t('histExportContextChanged'))); assert(html.includes(t('histExportDefinitionNote'))); assert(html.includes('00:00:00.123'))
}
assert.equal(callbacks, 0)
// Execute only the modal's actual invalidation callback/blocked expression.
const modalSource = ts.createSourceFile('HistoryExportModal.tsx', readFileSync(new URL('../apps/web/src/HistoryExportModal.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const invalidateEffect = find(modalSource, node => ts.isCallExpression(node) && node.expression.getText(modalSource) === 'useEffect' && node.arguments[0]?.getText(modalSource).includes('setInvalidated')) as ts.CallExpression
const blocked = (find(modalSource, node => ts.isVariableDeclaration(node) && node.name.getText(modalSource) === 'blocked') as ts.VariableDeclaration).initializer!
assert(invalidateEffect && blocked)
const modalEvaluate = (node: ts.Node, names: string[], values: unknown[]) => new Function(...names, ts.transpileModule('const result = ' + node.getText(modalSource) + '; return result', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...values)
const controller = new AbortController(); let invalidated = false, busy = true
modalEvaluate(invalidateEffect.arguments[0], ['contextCurrent', 'setInvalidated', 'controller', 'setBusy'], [false, (value: boolean) => { invalidated = value }, { current: controller }, (value: boolean) => { busy = value }])()
assert(controller.signal.aborted); assert(invalidated); assert.equal(busy, false)
assert.equal(modalEvaluate(blocked, ['invalidated', 'contextCurrent'], [invalidated, true]), true, 'returning to old values does not re-enable the invalidated dialog; close and reopen')
console.log('HISTORY EXPORT CONTEXT OK: real legacy missing-column repro plus actual App context/capture/live-ref/onPick/disabled wiring, strict independent capture, deletion/unverified/connection/source/type guards, delayed response/body rejection, unchanged success/reopen/cancel, bilingual SSR; mock/injected read-only I/O only, no files downloaded, service, real DB/device or model')
