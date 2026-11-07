/** Known-gap audit, not a safety regression test. Mock-only, no app bootstrap or user data. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { Sink } from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { captureHistoryExport, downloadHistoryExport, historyExportUrl } from '../apps/web/src/history-export.ts'
import { withRegisterSources } from '../packages/core/src/sample-source.ts'
import { historyReadContextKey } from '../apps/web/src/history-read-context.ts'
import { queryMemoryContext } from '../apps/web/src/history-query-memory.ts'

if (process.argv.slice(2).join(' ') !== '--mock') throw new Error('只接受 --mock；此工具不接受地址、数据库或工作区路径。')
const device = { id: 7, mode: 'master', transport: 'tcp', ip: 'mock.invalid', port: 502 }, group = { id: 10, objectId: 7, name: 'mock', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1 }
const point = { id: 101, objectId: 7, groupId: 10, alias: 'opening', functionCode: 3, startAddress: 0, dataType: 'uint16', factor: 1, offset: 0, unit: null, enumJson: null }
const time = Date.parse('2026-11-07T00:00:00.123Z')
const rows = () => withRegisterSources([point], [group], device)
const context = () => ({ definitions: historyReadContextKey(device, [group], rows())!, device: queryMemoryContext(device, rows()).deviceKey! })
const signature = () => createHash('sha256').update(JSON.stringify([device, group, point])).digest('hex')
const opening = context(), revision = signature(), request = captureHistoryExport(7, { start: time, end: time + 1000 }, [101], 0, 'full', opening)
let storeScope = 'old', queries = 0
const sink = new Sink({ config: { listRegistersByObject: () => [point], listGroups: () => [group], getObject: () => device }, store: {
  async queryObjectForExport(_id: number, _start: string, _end: string, ranges: Array<{ slaveId?: number }>) {
    queries++; const source = ranges[0].slaveId
    return [{ objectId: 7, area: 'holding-register', address: 0, slaveId: source, rawValue: storeScope === 'new' ? 900 : source === 1 ? 10 : 200, quality: 'good', batchId: 'mock-' + storeScope + '-' + source, timestampMs: time, ts: new Date(time).toISOString() }]
  },
} })
const app = Fastify(); registerHistoryExport(app, sink)
const valueOf = (csv: string) => csv.split('\n')[1].split(',')[1]
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
try {
  assert.equal(valueOf((await app.inject(historyExportUrl('csv', request))).body), '10')
  group.slaveId = 2; assert.notEqual(signature(), revision)
  let saved: Blob | undefined
  await downloadHistoryExport('csv', request, new AbortController().signal, () => opening, async url => {
    const response = await app.inject(String(url)); return new Response(response.body, { status: response.statusCode, headers: response.headers as any })
  }, blob => { saved = blob })
  assert(saved, 'a deliberately stale page context cannot detect a backend-only change')
  assert.equal(valueOf(await saved.text()), '200')
  for (const format of ['csv', 'xlsx'] as const) {
    const response = await app.inject({ url: historyExportUrl(format, request), headers: { 'if-match': '"' + revision + '"' } })
    assert.equal(response.statusCode, 200); assert(response.headers['content-disposition'])
    if (format === 'csv') assert.equal(valueOf(response.body), '200')
    else { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(response.rawPayload as any); assert.equal(workbook.getWorksheet('data')!.getCell('B2').value, '200') }
  }

  // Counterexample to a proposed separate preflight: not an implemented server check.
  group.slaveId = 1; const checkedRevision = signature(), checked = deferred<void>(), release = deferred<void>()
  const naive = (async () => { assert.equal(signature(), checkedRevision); checked.resolve(); await release.promise; return app.inject(historyExportUrl('csv', request)) })()
  await checked.promise; group.slaveId = 2; release.resolve()
  assert.equal(valueOf((await naive).body), '200', 'a separate check does not bind the definitions later consumed by export')

  // Execute the reviewed production switch method with EVERY effect injected as mock.
  const workspaceSource = ts.createSourceFile('workspace.ts', readFileSync(new URL('../packages/workspace/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const workspaceClass = workspaceSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Workspace') as ts.ClassDeclaration
  const method = workspaceClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(workspaceSource) === 'switchTo') as ts.MethodDeclaration
  assert(method?.body)
  const switchMock = new Function('resolve', 'mkdirSync', 'join', ts.transpileModule('return async function(path: string) ' + method.body.getText(workspaceSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)((path: string) => path, () => {}, (path: string, file: string) => path + '/' + file)
  const entered = deferred<void>(), finish = deferred<void>(); let configReopened = false, stops = 0, starts = 0
  const workspace = { current: 'old', addToRegistry() {}, ctx: { poller: { async stopAll() { stops++ }, startAll() { starts++ } }, store: { async reopen() { storeScope = 'new'; entered.resolve(); await finish.promise } }, config: { reopen() { configReopened = true } }, emit() {} } }
  group.slaveId = 1; const oldConfiguration = signature(), switching = switchMock.call(workspace, 'synthetic-mock-workspace')
  await entered.promise
  assert.equal(configReopened, false); assert.equal(signature(), oldConfiguration)
  assert.equal(valueOf((await app.inject(historyExportUrl('csv', request))).body), '900', 'the actual switch ordering can expose old mock configuration while the mock store has changed')
  finish.resolve(); await switching; assert(configReopened); assert.equal(stops, 1); assert.equal(starts, 1); assert.equal(signature(), oldConfiguration, 'identical configuration values do not identify a different store/workspace')
  console.log(JSON.stringify({ audit: 'KNOWN GAPS REPRODUCED; NOT A SAFETY PASS', stalePage: '10→200', legacyIfMatch: 'ignored for CSV and XLSX', separatePreflight: 'does not bind use', workspaceMethodWithMockEffects: 'same configuration + new store gives 900', queries, productionChanged: false }))
} finally { await app.close() }
