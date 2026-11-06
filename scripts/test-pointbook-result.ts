import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PointBookImportResult } from '../apps/web/src/PointBookImportResult.tsx'
import { InvalidPointBookReportError, parsePointBookReport, pointBookReportKind, uploadPointBook } from '../apps/web/src/pointbook-result.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import ExcelJS from 'exceljs'

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
