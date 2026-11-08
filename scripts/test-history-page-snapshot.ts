import assert from 'node:assert/strict'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import Fastify from 'fastify'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { historyQueryPlan, startHistoryQuery } from '../apps/web/src/history-query-task.ts'
import { reduceHistoryRead, historyReadView, type HistoryReadState } from '../apps/web/src/history-read-context.ts'

const dir = mkdtempSync(join(tmpdir(), 'probestation-page-snapshot-'))
const now = Date.parse('2026-11-08T12:00:00Z'), start = '2026-11-08T11:58:00Z', end = '2026-11-08T12:01:00Z', savedNow = Date.now
const failures: unknown[] = []; let passed = 0
Date.now = () => now
const options = (dbPath = ':memory:', retentionSeconds = 0) => ({ dbPath, retentionSeconds, retentionCheckMs: 0, flushIntervalMs: 0, flushBatchSize: 1000 })
const point = (seconds: number, rawValue: number) => ({ objectId: 1, area: 'holding-register' as const, address: 0, timestamp: new Date(now - seconds * 1000).toISOString(), rawValue, quality: 'good', batchId: 'synthetic-' + rawValue, slaveId: 1 })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('PAGE SNAPSHOT OK:', name) }
  catch (error) { failures.push(error); console.error('PAGE SNAPSHOT FAILED:', name, error) }
}
async function ready(retentionSeconds = 0) {
  const store = new DuckDBStore(options(':memory:', retentionSeconds), undefined, () => {})
  await (store as any).ready; await Promise.resolve(); await (store as any).mutations
  return store
}
const page = (store: DuckDBStore) => store.queryObjectPage(1, start, end, 0, 1)
async function interleave(store: DuckDBStore, action: () => Promise<void>) {
  const main = await (store as any).ready, instance = (store as any).instance, connect = instance.connect.bind(instance)
  let armed = true
  const wrap = (conn: any) => {
    const run = conn.runAndReadAll.bind(conn)
    conn.runAndReadAll = async (sql: string, ...args: any[]) => {
      const result = await run(sql, ...args)
      if (armed && sql.includes('SELECT DISTINCT ts')) { armed = false; await action() }
      return result
    }
  }
  wrap(main); instance.connect = async () => { const conn = await connect(); wrap(conn); return conn }
  return () => { instance.connect = connect }
}
try {
  await check('cleanup between native SELECTs cannot produce empty page with positive total', async () => {
    const store = await ready(60)
    try {
      store.write([point(61, 1), point(59, 2)]); await store.flush()
      const restore = await interleave(store, () => store.cleanup())
      try {
        const result = await page(store)
        assert.deepEqual([result.total, result.points.map(row => row.rawValue), result.hasMore], [2, [1], true], 'one response must describe one snapshot, not an empty page while a later timestamp still exists')
      } finally { restore() }
      const fresh = await page(store)
      assert.equal(fresh.total, 1); assert.deepEqual(fresh.points.map(row => row.rawValue), [2]); assert.equal(fresh.hasMore, false)
    } finally { await store.close() }
  })
  await check('late earlier-timestamp flush cannot shift membership/count within an accepted page', async () => {
    const store = await ready()
    try {
      store.write([point(50, 1), point(10, 2)]); await store.flush()
      const restore = await interleave(store, async () => { store.write([point(55, 0)]); await store.flush() })
      try { const result = await page(store); assert.equal(result.total, 2); assert.deepEqual(result.points.map(row => row.rawValue), [1]) }
      finally { restore() }
      const fresh = await page(store); assert.equal(fresh.total, 3); assert.deepEqual(fresh.points.map(row => row.rawValue), [0])
    } finally { await store.close() }
  })
  for (const stage of ['begin', 'select', 'commit', 'rollback-and-close', 'close']) await check('query error/resource release: ' + stage, async () => {
    const store = await ready(), original = new Error('synthetic page ' + stage), rollback = new Error('synthetic rollback'), closeError = new Error('synthetic close')
    store.write([point(10, 1)]); await store.flush()
    const instance = (store as any).instance, connect = instance.connect.bind(instance)
    let closed = 0, rollbacks = 0
    instance.connect = async () => {
      const conn = await connect(), run = conn.run.bind(conn), read = conn.runAndReadAll.bind(conn), close = conn.closeSync.bind(conn)
      conn.run = async (sql: string, ...args: any[]) => {
        if (stage === 'begin' && sql === 'BEGIN TRANSACTION' || stage === 'commit' && sql === 'COMMIT') throw original
        if (sql === 'ROLLBACK') { rollbacks++; if (stage === 'rollback-and-close') throw rollback }
        return run(sql, ...args)
      }
      conn.runAndReadAll = async (sql: string, ...args: any[]) => { if (['select', 'rollback-and-close'].includes(stage) && sql.includes('COUNT(DISTINCT ts)')) throw original; return read(sql, ...args) }
      conn.closeSync = () => { close(); closed++; if (stage === 'close' || stage === 'rollback-and-close') throw closeError }
      return conn
    }
    try {
      await assert.rejects(page(store), error => stage === 'rollback-and-close' ? error instanceof AggregateError && error.errors.length === 3 && error.errors.includes(original) && error.errors.includes(rollback) && error.errors.includes(closeError) : error === (stage === 'close' ? closeError : original))
      assert.equal(closed, 1); assert.equal(rollbacks, ['begin', 'close'].includes(stage) ? 0 : 1)
      instance.connect = connect
      assert.equal((await page(store)).total, 1, 'a subsequent explicit query remains usable')
    } finally { instance.connect = connect; await store.close() }
  })
  for (const operation of ['close', 'reopen']) await check('accepted page reader is drained before ' + operation, async () => {
    const store = await ready(), entered = deferred(), release = deferred()
    store.write([point(10, 1)]); await store.flush()
    const restore = await interleave(store, async () => { entered.resolve(); await release.promise })
    const reading = page(store); await entered.promise
    let finished = false
    const switching = (operation === 'close' ? store.close() : store.reopen(':memory:')).then(() => { finished = true })
    try {
      await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false)
      release.resolve(); assert.equal((await reading).total, 1); await switching
      if (operation === 'close') await assert.rejects(page(store), /closing or closed/)
      else assert.equal((await page(store)).total, 0)
    } finally { release.resolve(); restore(); await reading.catch(() => {}); await switching; await store.close() }
  })
  await check('failed synthetic migration -> actual page API/client error -> explicit retry and genuine empty result', async () => {
    const path = join(dir, 'invalid.duckdb'), db = await DuckDBInstance.create(path), conn = await db.connect()
    try { await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR, batch_id INTEGER)') }
    finally { conn.closeSync(); db.closeSync() }
    const failed = new DuckDBStore(options(path), undefined, () => {}), good = await ready()
    const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    let route: ts.CallExpression | undefined
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/data/object/page') route = node; ts.forEachChild(node, visit) }; visit(apiSource); assert(route)
    const uiSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const declaration = (name: string) => uiSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
    const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
    const app = Fastify(); let active = failed
    new Function('fastify', 'store', transpile(route.getText(apiSource)))(app, { queryObjectPage: (...args: Parameters<DuckDBStore['queryObjectPage']>) => active.queryObjectPage(...args) })
    const request = new Function('fetch', 'configurationWriteReceipt', 'CONFIG_WRITE_NOT_STARTED', transpile(declaration('request').getText(uiSource)) + ';return request')(async (url: string) => { const result = await app.inject(url); return { ok: result.statusCode < 400, status: result.statusCode, text: async () => result.body, json: async () => result.json() } }, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED)
    const body = new Function('React', 'chartCursorLabel', 'PointLabel', transpile(declaration('HistoryTableBody').getText(uiSource)) + ';return HistoryTableBody')(React, String, () => null)
    let state: HistoryReadState<any> | null = null
    const run = async (revision: number) => {
      const plan = historyQueryPlan({ objectId: 1, start: Date.parse(start), end: Date.parse(end), mode: 'table', page: 0, registerIds: [1], revision })!
      await new Promise<void>(resolve => startHistoryQuery(plan, (url: string) => request(url), event => { state = reduceHistoryRead(state, plan, event); if (event.status !== 'loading') resolve() }, { delayMs: 0 }))
      return historyReadView(plan, state)
    }
    try {
      await assert.rejects((failed as any).ready, /batch_id/)
      const error = await run(0); assert.equal(error.status, 'error'); assert.equal(error.data, null)
      const html = renderToStaticMarkup(createElement(body, { pointLabels: new Map(), t: (key: string) => key, rows: [], selectedRegisters: [{ id: 1 }], status: error.status, error: String(error.error), page: 0, total: 0, pageSize: 200, onPageChange() {} }))
      assert(html.includes('histError') && !html.includes('histEmpty'))
      active = good; const recovered = await run(1); assert.equal(recovered.status, 'done'); assert.equal(recovered.data.total, 0); assert.deepEqual(recovered.data.points, [])
      good.write([point(10, 7)]); await good.flush()
      const populated = await run(2); assert.equal(populated.status, 'done'); assert.equal(populated.data.points[0].rawValue, 7); assert.equal(populated.data.points[0].batchId, 'synthetic-7')
    } finally { await app.close(); await good.close(); await assert.rejects(failed.close(), /batch_id/) }
  })
} finally {
  Date.now = savedNow
  const inside = relative(realpathSync(tmpdir()), realpathSync(dir))
  assert(inside && inside.startsWith('probestation-page-snapshot-') && !inside.startsWith('..') && !inside.includes(':'))
  rmSync(dir, { recursive: true, force: true })
}
if (failures.length) throw new AggregateError(failures, `${failures.length} page snapshot cases failed; ${passed} passed`)
console.log(`HISTORY PAGE SNAPSHOT TEST OK: ${passed} cases, native memory/temp databases, no real services or devices`)
