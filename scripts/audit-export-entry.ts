/** Actual export entry audit. Known gaps are expected; exit zero is NOT a safety pass. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Context } from 'cordis'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { captureHistoryExport, historyExportUrl } from '../apps/web/src/history-export.ts'
import { historyReadContextKey } from '../apps/web/src/history-read-context.ts'
import { queryMemoryContext } from '../apps/web/src/history-query-memory.ts'
import { withRegisterSources } from '../packages/core/src/sample-source.ts'

if (process.argv.slice(2).join(' ') !== '--memory') throw new Error('只接受 --memory，不接受地址或文件库路径。')
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../apps/cli/src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const plugins: string[] = []
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(source) === 'ctx.plugin') plugins.push(node.arguments[0].getText(source)); ts.forEachChild(node, visit) }
visit(source)
assert(!source.statements.some(node => ts.isImportDeclaration(node) && /workspace/.test(node.moduleSpecifier.getText(source))))
assert(!plugins.some(name => /workspace/i.test(name)))
assert(plugins.indexOf('configPlugin') >= 0 && plugins.indexOf('storePlugin') > plugins.indexOf('configPlugin') && plugins.indexOf('sinkPlugin') > plugins.indexOf('storePlugin'))
// Only these actual plugin entry points are executed, with explicit memory paths and no timers.
// Never execute main.ts, API bootstrap, poller, slave, modbus, MCP or model providers.
const ctx = new Context(), app = Fastify()
let cfg: configPlugin.ConfigStore | undefined, store: storePlugin.DuckDBStore | undefined
try {
  await ctx.plugin(configPlugin, { dbPath: ':memory:' })
  await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 })
  await ctx.plugin(sinkPlugin)
  cfg = ctx.get('config', false) as configPlugin.ConfigStore; store = ctx.get('store', false) as storePlugin.DuckDBStore
  const sink = ctx.get('sink', false) as sinkPlugin.Sink
  assert.equal(ctx.get('workspace', false), undefined)
  await (store as any).ready
  const device = cfg.createObject('synthetic', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'group', 3, 0, 1, 'read', 1), point = cfg.createRegister(group.id, device.id, 'point', 3, 0, 'uint16')
  const time = Date.parse('2026-11-07T00:00:00.123Z'), start = new Date(time).toISOString(), end = new Date(time + 1000).toISOString()
  store.write([1, 2].map(slaveId => ({ objectId: device.id, area: 'holding-register' as const, address: 0, timestamp: start, rawValue: slaveId === 1 ? 10 : 200, quality: 'good', slaveId, batchId: 'source-' + slaveId }))); await store.flush()
  const points = withRegisterSources(cfg.listRegistersByObject(device.id), cfg.listGroups(device.id), device)
  const opening = { definitions: historyReadContextKey(device, [group], points)!, device: queryMemoryContext(device, points).deviceKey! }
  const request = captureHistoryExport(device.id, { start: time, end: time + 1000 }, [point.id], 0, 'full', opening)
  let snapshots = 0, handles = 0
  const snapshot = cfg.getHistoryExportConfiguration.bind(cfg), capture = store.captureExportReadHandle.bind(store)
  cfg.getHistoryExportConfiguration = id => { snapshots++; return snapshot(id) }
  store.captureExportReadHandle = () => { handles++; return capture() }
  registerHistoryExport(app, sink)
  const exportedValue = async (format: 'csv' | 'xlsx', expected: string) => {
    const response = await app.inject(historyExportUrl(format, request)); assert.equal(response.statusCode, 200); assert(response.headers['content-disposition'])
    if (format === 'csv') assert.equal(response.body.split('\n')[1].split(',')[1], expected)
    else { const book = new ExcelJS.Workbook(); await book.xlsx.load(response.rawPayload as any); assert.equal(book.getWorksheet('data')!.getCell('B2').value, expected) }
  }
  for (const format of ['csv', 'xlsx'] as const) await exportedValue(format, '10')
  cfg.updateGroup(group.id, { slaveId: 2 })
  const changedDevice = cfg.getObject(device.id); assert(changedDevice)
  const changed = withRegisterSources(cfg.listRegistersByObject(device.id), cfg.listGroups(device.id), changedDevice)
  assert.notEqual(historyReadContextKey(changedDevice, cfg.listGroups(device.id), changed), opening.definitions)
  for (const format of ['csv', 'xlsx'] as const) await exportedValue(format, '200')
  assert.equal(snapshots, 0); assert.equal(handles, 0, 'existing exports never opt into the new internal capabilities')
  // Verify reusable components independently; this deliberately does not declare a startup pairing.
  const graph = cfg.getHistoryExportConfiguration(device.id), handle = store.captureExportReadHandle()
  const rows = await store.queryObjectForExportWithHandle(handle, device.id, start, end, [{ area: 'holding-register', startAddress: 0, endAddress: 0, slaveId: graph.groups[0].slaveId }])
  assert.equal(rows[0].rawValue, 200); store.validateExportReadHandle(handle)
  assert.equal(cfg.getHistoryExportConfigurationScope(), graph.configurationScope)
  console.log(JSON.stringify({ audit: 'ACTUAL ENTRY GAP REPRODUCED; NOT A SAFETY PASS', topology: 'config/store/sink, no Workspace', entry: 'actual plugin apply → Sink → shared Fastify export routes (inject only)', oldCsvXlsxWorkWithoutWorkspace: true, backendOnlySourceChangeWithSameRequest: '10→200', legacyCapabilityCalls: { snapshots: 0, handles: 0 }, independentMemoryComponents: 'usable, not startup pairing', database: ':memory: only', mainExecuted: false, listeners: false, productionChanged: false }))
} finally {
  await app.close()
  if (store) { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
  ;(cfg as any)?.db.close()
}
