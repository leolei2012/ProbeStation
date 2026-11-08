import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { Sink } from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { captureHistoryExport, downloadHistoryExport, HistoryExportContextChangedError, historyExportRangeLabel } from '../apps/web/src/history-export.ts'
import { HistoryExportLimitError } from '../packages/core/src/history-export-policy.ts'
import { runHistoryQuery, HistoryQueryTimeoutError } from '../apps/web/src/history-query.ts'
import { startHistoryQuery, historyQueryPlan } from '../apps/web/src/history-query-task.ts'
import { reduceHistoryRead, historyReadView, type HistoryReadState } from '../apps/web/src/history-read-context.ts'

// Actual component functions with deterministic hooks, not a browser/React DOM renderer.
// Actual Sink/routes generate memory-only files; save is an injected memory counter.
const parse = (name: string, url: URL) => ts.createSourceFile(name, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const appSource = parse('App.tsx', new URL('../apps/web/src/App.tsx', import.meta.url)), modalSource = parse('HistoryExportModal.tsx', new URL('../apps/web/src/HistoryExportModal.tsx', import.meta.url))
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const fn = (source: ts.SourceFile, name: string) => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)
const find = (node: ts.Node, match: (node: ts.Node) => boolean): ts.Node | undefined => { if (match(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, match) }); return result }
const i18n = (find(appSource, node => ts.isVariableDeclaration(node) && node.name.getText(appSource) === 'I18N') as ts.VariableDeclaration).initializer!
assert(!find(i18n, ts.isCallExpression), 'only literal translations are evaluated')
const messages = new Function(compile('return (' + i18n.getText(appSource) + ')'))()
const source = fn(modalSource, 'HistoryExportModal').replace(/^export /, '')
const elements = (value: any): any[] => Array.isArray(value) ? value.flatMap(elements) : React.isValidElement(value) ? [value, ...elements((value.props as any).children)] : []
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const start = Date.parse('2026-11-06T00:00:00Z'), context = { definitions: 'synthetic definitions', device: 'synthetic device' }
const request = captureHistoryExport(1, { start, end: start + 1000 }, [1], 0, 'full', context)
function driver(pick: (format: 'csv' | 'xlsx', signal: AbortSignal) => Promise<void>, english = false, timeoutMs = 30000, captured = request) {
  const cells: any[] = [], deps: any[] = [], cleanups = new Map<number, () => void>()
  let cursor = 0, tree: any, effects: Array<() => void> = [], dirty = false, mounted = true, closes = 0, calls = 0, lateUpdates = 0
  const useState = (initial: any) => { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], (value: any) => { if (!mounted) { lateUpdates++; return }; const next = typeof value === 'function' ? value(cells[index]) : value; if (!Object.is(next, cells[index])) { cells[index] = next; dirty = true } }] }
  const useRef = (initial: any) => useState(() => ({ current: initial }))[0]
  const useEffect = (effect: () => void | (() => void), next: any[]) => { const index = cursor++; if (!deps[index] || next.some((value, i) => !Object.is(value, deps[index][i]))) effects.push(() => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup) }); deps[index] = next }
  const env = { React, useState, useRef, useEffect, useId: () => { const id = cursor; return useState('synthetic-' + id)[0] }, document: { activeElement: { focus() {} } }, HistoryExportContextChangedError, historyExportRangeLabel, HistoryExportLimitError, HistoryQueryTimeoutError, runHistoryQuery: (fetcher: (signal: AbortSignal) => Promise<void>, signal: AbortSignal) => runHistoryQuery(fetcher, signal, timeoutMs) }
  const Component = new Function(...Object.keys(env), compile(source) + ';return HistoryExportModal')(...Object.values(env))
  const props = { request: captured, contextCurrent: true, t: (key: string) => messages[english ? 'en' : 'zh'][key] ?? key, onClose() { closes++ }, async onPick(format: 'csv' | 'xlsx', signal: AbortSignal) { calls++; await pick(format, signal) } }
  const render = () => { for (let i = 0; i < 5; i++) { dirty = false; cursor = 0; effects = []; tree = Component(props); for (const effect of effects) effect(); if (!dirty) return tree }; throw new Error('synthetic hook render did not settle') }
  const button = (key: string) => { render(); return elements(tree).find(node => node.type === 'button' && node.props.children === props.t(key)) }
  const state = () => { render(); return { html: renderToStaticMarkup(tree), disabled: ['exportCsv', 'exportXlsx'].map(key => !!button(key).props.disabled), alerts: elements(tree).filter(node => node.props.role === 'alert').map(node => String(node.props.children)) } }
  render()
  return { props, render, state, click: (key: string) => button(key).props.onClick(), deadline: (ms: number) => { timeoutMs = ms }, get closes() { return closes }, get calls() { return calls }, get lateUpdates() { return lateUpdates }, async wait(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await tick() }; throw new Error('synthetic modal did not settle') }, unmount() { for (const cleanup of cleanups.values()) cleanup(); mounted = false } }
}
const failures: unknown[] = []; let passed = 0
async function check(name: string, action: () => Promise<void>) { try { await action(); passed++; console.log('HISTORY FEEDBACK OK:', name) } catch (error) { failures.push(error); console.error('HISTORY FEEDBACK FAILED:', name, error) } }

await check('actual query request/task/table distinguish empty, HTTP failure, cancellation and late error', async () => {
  const Request = new Function('fetch', compile(fn(appSource, 'request')) + ';return request')
  const Table = new Function('React', 'PointLabel', 'chartCursorLabel', compile(fn(appSource, 'HistoryTableBody')) + ';return HistoryTableBody')(React, () => null, String)
  let response: () => Promise<Response> = async () => new Response(JSON.stringify({ points: [], total: 0 }))
  const request = Request(() => response())
  const pendingRequests: Promise<any>[] = []
  let state: HistoryReadState<any> | null = null
  const render = (view: ReturnType<typeof historyReadView<any>>) => renderToStaticMarkup(React.createElement(Table, { pointLabels: new Map(), t: (key: string) => key, rows: [], selectedRegisters: [{ id: 1 }], status: view.status, error: String(view.error), page: 0, total: view.data?.total ?? 0, pageSize: 200, onPageChange() {} }))
  const begin = (revision: number) => {
    const plan = historyQueryPlan({ objectId: 1, start, end: start + 1000, mode: 'table', page: 0, registerIds: [1], revision })!, done = deferred<void>()
    const task = startHistoryQuery(plan, (url, signal) => { const pending = request(url, { signal }); pendingRequests.push(pending); return pending }, event => { state = reduceHistoryRead(state, plan, event); if (event.status !== 'loading') done.resolve() }, { delayMs: 0 })
    return { task, done: done.promise, view: () => historyReadView(plan, state) }
  }
  const empty = begin(0); await empty.done; assert(render(empty.view()).includes('histEmpty'))
  response = async () => new Response(JSON.stringify({ error: 'synthetic failure' }), { status: 503 })
  const failed = begin(1); await failed.done; assert.equal(failed.view().status, 'error'); const html = render(failed.view()); assert(html.includes('histError') && !html.includes('histEmpty'))
  const entered = deferred<void>(), late = deferred<Response>()
  response = async () => { entered.resolve(); return late.promise }
  const canceled = begin(2); await entered.promise; canceled.task.cancel(); await canceled.done
  assert.equal(canceled.view().status, 'idle'); assert(render(canceled.view()).includes('histCancelled'))
  response = async () => new Response(JSON.stringify({ points: [], total: 0 }))
  const recovered = begin(3); await recovered.done; const before = state
  late.resolve(new Response(JSON.stringify({ error: 'old failure' }), { status: 503 })); await Promise.allSettled(pendingRequests); await tick()
  assert.equal(state, before); assert.equal(recovered.view().status, 'done'); assert(render(recovered.view()).includes('histEmpty'))
})

const point = { id: 1, objectId: 1, groupId: 1, alias: 'synthetic', startAddress: 0, functionCode: 3, dataType: 'uint16' }
let failing = false
const sink = new Sink({ config: { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => [{ id: 1, slaveId: 1, startAddress: 0, quantity: 1 }], listRegistersByObject: () => [point] }, store: { async queryObjectForExport() { if (failing) throw Object.assign(new Error('synthetic storage failure'), { statusCode: 503 }); return [] } } })
const app = Fastify(); registerHistoryExport(app, sink)
const adapter: typeof fetch = async (url, init) => { assert(init?.signal instanceof AbortSignal); const response = await app.inject(String(url)); if (response.statusCode >= 400) assert.equal(response.headers['content-disposition'], undefined); return new Response(response.rawPayload as any, { status: response.statusCode, headers: response.headers as any }) }
try {
  await check('actual empty CSV/XLSX are valid header-only files; failure remains open and explicit retry recovers', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
      const saves: Blob[] = []; failing = true
      const modal = driver((kind, signal) => downloadHistoryExport(kind, request, signal, () => context, adapter, blob => { saves.push(blob) }))
      try {
        modal.click(format === 'csv' ? 'exportCsv' : 'exportXlsx'); await modal.wait(() => modal.state().alerts.some(text => text.includes('HTTP 503')))
        assert.equal(modal.closes, 0); assert.equal(saves.length, 0); assert.deepEqual(modal.state().disabled, [false, false]); assert.equal(modal.calls, 1)
        failing = false; modal.click(format === 'csv' ? 'exportCsv' : 'exportXlsx'); await modal.wait(() => modal.closes === 1)
        assert.equal(modal.calls, 2); assert.equal(saves.length, 1)
        if (format === 'csv') assert.equal((await saves[0].text()).split('\n').length, 1)
        else { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await saves[0].arrayBuffer()) as any); assert.equal(workbook.getWorksheet('data')!.rowCount, 1) }
      } finally { modal.unmount() }
    }
  })
  await check('cancel/unmount suppress late headers/body and cannot close or change a new dialog', async () => {
    for (const stage of ['headers', 'body']) {
      const entered = deferred<void>(), headers = deferred<Response>(), body = deferred<Blob>(), saves: Blob[] = [], pending: Promise<void>[] = []
      const fetcher: typeof fetch = async () => { if (stage === 'headers') { entered.resolve(); return headers.promise }; return { ok: true, headers: new Headers({ 'content-type': 'text/csv' }), blob: () => { entered.resolve(); return body.promise } } as Response }
      const old = driver((format, signal) => { const task = downloadHistoryExport(format, request, signal, () => context, fetcher, blob => { saves.push(blob) }); pending.push(task); return task })
      old.click('exportCsv'); await entered.promise; old.click('cancel'); old.unmount(); assert.equal(old.closes, 1)
      const fresh = driver((format, signal) => downloadHistoryExport(format, request, signal, () => context, adapter, blob => { saves.push(blob) }))
      try {
        fresh.click('exportCsv'); await fresh.wait(() => fresh.closes === 1); assert.equal(saves.length, 1)
        if (stage === 'headers') headers.resolve(new Response('timestamp\n', { headers: { 'content-type': 'text/csv' } })); else body.resolve(new Blob(['timestamp\n']))
        await Promise.allSettled(pending); await tick()
        assert.equal(saves.length, 1); assert.equal(old.closes, 1); assert.equal(fresh.closes, 1); assert.equal(old.lateUpdates, 0)
      } finally { fresh.unmount() }
    }
  })
  await check('timeout is distinct from cancel, aborts late save and permits explicit retry', async () => {
    const entered = deferred<void>(), body = deferred<Blob>(), saves: Blob[] = [], pending: Promise<void>[] = []
    let fetcher: typeof fetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/csv' }), blob: () => { entered.resolve(); return body.promise } } as Response)
    const modal = driver((format, signal) => { const task = downloadHistoryExport(format, request, signal, () => context, (...args) => fetcher(...args), blob => { saves.push(blob) }); pending.push(task); return task }, false, 5)
    try {
      modal.click('exportCsv'); await entered.promise; await modal.wait(() => modal.state().alerts.includes(messages.zh.histExportTimeout))
      assert.equal(modal.closes, 0); assert.deepEqual(modal.state().disabled, [false, false]); assert.equal(saves.length, 0)
      fetcher = adapter; modal.deadline(30000); modal.click('exportCsv'); await modal.wait(() => modal.closes === 1)
      body.resolve(new Blob(['timestamp\n'])); await Promise.allSettled(pending); await tick()
      assert.equal(saves.length, 1); assert.equal(modal.closes, 1)
    } finally { modal.unmount() }
  })
  await check('actual context-error result locks the dialog even before contextCurrent prop changes', async () => {
    for (const english of [false, true]) {
      const entered = deferred<void>(), body = deferred<Blob>(); let current = context, saves = 0
      const fetcher: typeof fetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/csv' }), blob: () => { entered.resolve(); return body.promise } } as Response)
      const modal = driver((format, signal) => downloadHistoryExport(format, request, signal, () => current, fetcher, () => { saves++ }), english)
      try {
        modal.click('exportCsv'); await entered.promise; current = { ...context, definitions: 'changed' }; body.resolve(new Blob(['timestamp\n']))
        const message = messages[english ? 'en' : 'zh'].histExportContextChanged
        await modal.wait(() => modal.state().alerts.includes(message))
        assert.equal(saves, 0); assert.equal(modal.closes, 0); assert.deepEqual(modal.state().disabled, [true, true], 'configuration-error message requires close/reopen, not enabled retry buttons')
        assert.equal(modal.state().alerts.filter(text => text === message).length, 1)
        current = context; modal.render(); modal.click('exportCsv'); await tick(); assert.equal(modal.calls, 1, 'old capture remains blocked after values return')
        modal.click('cancel'); assert.equal(modal.closes, 1)
      } finally { modal.unmount() }
      const fresh = captureHistoryExport(1, { start, end: start + 1000 }, [1], 0, 'full', context); assert.notEqual(fresh, request)
      const reopened = driver((format, signal) => downloadHistoryExport(format, fresh, signal, () => context, adapter, () => { saves++ }), english, 30000, fresh)
      try { reopened.click('exportCsv'); await reopened.wait(() => reopened.closes === 1); assert.equal(saves, 1) } finally { reopened.unmount() }
    }
  })
} finally { await app.close() }
if (failures.length) throw new AggregateError(failures, `${failures.length} feedback cases failed; ${passed} passed`)
console.log(`HISTORY FEEDBACK TEST OK: ${passed} actual query/modal/route cases, no network, real DB or browser downloads`)
