import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { HistoryPaginationNotice } from '../apps/web/src/HistoryPaginationNotice.tsx'
import { historyQueryPlan, startHistoryQuery } from '../apps/web/src/history-query-task.ts'

// Native memory databases and actual table component/function; no app entry, network or hardware.
const now = Date.parse('2026-11-08T12:00:00Z'), savedNow = Date.now
const start = '2026-11-08T11:40:00Z', end = '2026-11-08T12:01:00Z'
const errors: unknown[] = []; let passed = 0
Date.now = () => now
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('HISTORY PAGINATION OK:', name) }
  catch (error) { errors.push(error); console.error('HISTORY PAGINATION FAILED:', name, error) }
}
const point = (age: number, rawValue: number) => ({ objectId: 1, area: 'holding-register' as const, address: 0, timestamp: new Date(now - age * 1000).toISOString(), rawValue, quality: 'good', batchId: 'synthetic-' + rawValue, slaveId: 1 })
async function storeWith(retentionSeconds: number, samples: ReturnType<typeof point>[]) {
  const store = new DuckDBStore({ dbPath: ':memory:', retentionSeconds, retentionCheckMs: 0, flushIntervalMs: 0, flushBatchSize: 1000 })
  await (store as any).ready; await Promise.resolve(); await (store as any).mutations
  store.write(samples); await store.flush(); return store
}
const values = (result: Awaited<ReturnType<DuckDBStore['queryObjectPage']>>) => result.points.map(row => row.rawValue)
const sourceText = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('App.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HistoryTableBody')!
const compiled = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const Table = new Function('React', 'PointLabel', 'chartCursorLabel', 'HistoryPaginationNotice', compiled + ';return HistoryTableBody')(React, () => null, String, HistoryPaginationNotice)
const props = (english: boolean, extra: object = {}) => ({ t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, pointLabels: new Map([[1, {}]]), rows: [{ ts: start, values: { 1: '1' } }], selectedRegisters: [{ id: 1 }], status: 'done', error: null, page: 0, total: 600, pageSize: 200, onPageChange() {}, ...extra })
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand)
  if (!React.isValidElement(value)) return value
  if (typeof value.type === 'function') return expand((value.type as any)(value.props))
  const element = value as React.ReactElement<any>
  return { type: element.type, props: { ...element.props, children: expand(element.props.children) } }
}
function buttons(value: any): any[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(buttons)
  return [...(value.type === 'button' ? [value] : []), ...buttons(value.props?.children)]
}
try {
  await check('native late earlier sample repeats a timestamp and omits the new sample across pages', async () => {
    const store = await storeWith(0, [90, 80, 70, 50, 40, 30].map((age, i) => point(age, i + 1)))
    try {
      const first = await store.queryObjectPage(1, start, end, 0, 2); assert.deepEqual(values(first), [1, 2])
      store.write([point(95, 0)]); await store.flush()
      const second = await store.queryObjectPage(1, start, end, 1, 2); assert.deepEqual(values(second), [2, 3])
      assert.equal(first.total, 6); assert.equal(second.total, 7)
      const collected = [...values(first), ...values(second), ...values(await store.queryObjectPage(1, start, end, 2, 2)), ...values(await store.queryObjectPage(1, start, end, 3, 2))]
      assert.equal(collected.length, second.total, 'matching the current count can still hide duplicate/missing timestamps')
      assert.equal(collected.filter(value => value === 2).length, 2); assert(!collected.includes(0))
      assert.deepEqual(values(await store.queryObjectPage(1, start, end, 0, 2)), [0, 1])
    } finally { await store.close() }
  })
  await check('native cleanup plus late write can omit a sample even with unchanged totals', async () => {
    const store = await storeWith(85, [90, 80, 70, 50, 40, 30].map((age, i) => point(age, i + 1)))
    try {
      const first = await store.queryObjectPage(1, start, end, 0, 2)
      await store.cleanup(); store.write([point(75, 25)]); await store.flush()
      const second = await store.queryObjectPage(1, start, end, 1, 2)
      assert.equal(first.total, 6); assert.equal(second.total, 6); assert.deepEqual(values(second), [3, 4])
      const collected = [...values(first), ...values(second), ...values(await store.queryObjectPage(1, start, end, 2, 2))]
      assert.equal(collected.length, second.total); assert(!collected.includes(25))
      assert.deepEqual(values(await store.queryObjectPage(1, start, end, 0, 2)), [2, 25])
    } finally { await store.close() }
  })
  await check('actual 200-size page expires out of range; actual table offers explicit first-page recovery', async () => {
    const store = await storeWith(201, Array.from({ length: 600 }, (_, i) => point(600 - i, i + 1)))
    try {
      assert.equal((await store.queryObjectPage(1, start, end, 2, 200)).total, 600)
      await store.cleanup()
      const missing = await store.queryObjectPage(1, start, end, 2, 200)
      assert.equal(missing.total, 201); assert.deepEqual(missing.points, [])
      for (const english of [false, true]) {
        let currentPage = 2, calls = 0
        const input = props(english, { rows: [], page: currentPage, total: missing.total, onPageChange(next: number) { calls++; currentPage = next } })
        const html = renderToStaticMarkup(createElement(Table, input))
        assert(!html.includes('histEmpty'), 'out-of-range page must not claim the whole range is empty')
        assert(html.includes(english ? 'beyond the page count' : '当前页已超出本次返回的页数'))
        const tree = expand(Table(input)), label = english ? 'Read again from first page' : '回到首页重新读取'
        const restart = buttons(tree).find(button => button.props.children === label)
        assert(restart); assert.equal(calls, 0, 'rendering must not automatically loop or change page')
        const before = historyQueryPlan({ objectId: 1, start: Date.parse(start), end: Date.parse(end), mode: 'table', page: currentPage, registerIds: [1] })!
        restart.props.onClick(); assert.equal(calls, 1); assert.equal(currentPage, 0)
        const after = historyQueryPlan({ objectId: 1, start: Date.parse(start), end: Date.parse(end), mode: 'table', page: currentPage, registerIds: [1] })!
        assert.notEqual(before.key, after.key)
        const recovered: any = await new Promise(resolve => startHistoryQuery(after, async url => { const query = new URL(url, 'http://mock.invalid').searchParams; return store.queryObjectPage(1, query.get('start')!, query.get('end')!, Number(query.get('page')), Number(query.get('page_size'))) }, event => { if (event.status !== 'loading') resolve(event) }, { delayMs: 0 }))
        assert.equal(recovered.status, 'done'); assert.equal(recovered.data.points.length, 200); assert.equal(recovered.data.points[0].rawValue, 400)
      }
    } finally { await store.close() }
  })
  await check('actual bilingual table explains independent pages without claiming detection or adding retries', async () => {
    for (const english of [false, true]) {
      let calls = 0
      const input = props(english, { onPageChange() { calls++ } })
      const html = renderToStaticMarkup(createElement(Table, input))
      assert(html.includes(english ? 'not from a cross-page snapshot' : '并非跨页快照'))
      assert(html.includes(english ? 'an unchanged total does not prove unchanged data' : '总数相同也不能证明数据未变化'))
      assert(html.includes(english ? 'does not guarantee completeness' : '仍不保证完整性'))
      const next = buttons(expand(Table(input))).find(button => button.props.children === 'histNext')
      assert(next && next.props.disabled === false); next.props.onClick(); assert.equal(calls, 1)
      for (const status of ['loading', 'idle', 'error']) {
        const other = renderToStaticMarkup(createElement(Table, { ...input, status, page: 2, rows: [], total: 0, error: 'synthetic' }))
        assert(!other.includes('history-pagination-notice')); assert(!other.includes(english ? 'Read again from first page' : '回到首页重新读取'))
      }
      const empty = renderToStaticMarkup(createElement(Table, { ...input, rows: [], total: 0 }))
      assert(empty.includes('histEmpty')); assert(!empty.includes('history-pagination-notice'))
      const cleared = renderToStaticMarkup(createElement(Table, { ...input, rows: [], total: 0, page: 1 }))
      assert(!cleared.includes('histEmpty')); assert(cleared.includes(english ? 'Read again from first page' : '回到首页重新读取'))
      assert(!renderToStaticMarkup(createElement(Table, { ...input, selectedRegisters: [] })).includes('history-pagination-notice'))
    }
    assert(sourceText.includes('onPageChange={setPage}'), 'production parent retains the existing state-driven query path')
  })
} finally { Date.now = savedNow }
if (errors.length) throw new AggregateError(errors, `${errors.length} cross-page cases failed; ${passed} passed`)
console.log(`HISTORY PAGINATION TEST OK: ${passed} native memory/actual UI cases; no cross-page snapshot claim`)
