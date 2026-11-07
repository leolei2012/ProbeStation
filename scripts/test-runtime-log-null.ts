import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { filterRuntimeLogs, InvalidRuntimeLogs, parseRuntimeLogs, RuntimeLogsRead, UNRECORDED_LOG_LEVEL } from '../apps/web/src/runtime-logs.ts'
import { RuntimeLogsView } from '../apps/web/src/RuntimeLogs.tsx'

// Real existing SQLite schema, isolated memory database only; no service or actual logs.
const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  ;(cfg as any).db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)').run('2026-11-07 12:00:00', 'WARN', null, null)
  const logs = cfg.listLogs()
  assert.equal(logs[0].source, null); assert.equal(logs[0].message, null)
  assert.equal(parseRuntimeLogs(logs)[0].source, null, 'schema-valid nullable logs must remain viewable without replacing their nulls')
  const columns = (cfg as any).db.prepare("PRAGMA table_info('logs')").all()
  for (const name of ['level', 'source', 'message']) assert.equal(columns.find((column: any) => column.name === name).notnull, 0)
  const insert = (cfg as any).db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)')
  for (const level of [null, '', 'WARN', 'null', 'all', 'missing']) for (const source of [null, '', 'mock-source']) for (const message of [null, '', 'payload']) insert.run('legacy timestamp', level, source, message)
  const raw = JSON.parse(JSON.stringify(cfg.listLogs(200))), rows = parseRuntimeLogs(raw)
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), raw, 'JSON roundtrip keeps null, empty and literal values distinct')
  assert.equal(rows.length, 55); assert(Object.isFrozen(rows)); assert(Object.isFrozen(rows[0]))
  assert.equal(filterRuntimeLogs(rows, UNRECORDED_LOG_LEVEL, '').length, 9)
  for (const level of ['', 'null', 'all', 'missing']) assert.equal(filterRuntimeLogs(rows, level, '').length, 9)
  assert.equal(filterRuntimeLogs(rows, null, '').length, 55, 'all levels remains separate from the missing-level filter')
  assert.equal(filterRuntimeLogs(rows, null, 'null').length, 9, 'only literal data matches null, never generated null placeholders')
  const reader = new RuntimeLogsRead(); cfg.clearLogs = () => { throw new Error('must not clear') }; cfg.log = () => { throw new Error('must not write') }
  try {
    await reader.refresh(async url => { assert.equal(url, '/api/logs?limit=200'); return cfg.listLogs(200) })
    assert.equal(reader.snapshot().phase, 'ready'); assert.deepEqual(reader.snapshot().rows, rows)
    await reader.refresh(async () => [{ id: 1, ts: '', level: null, source: null }]); assert.equal(reader.snapshot().error, 'invalid'); assert.deepEqual(reader.snapshot().rows, rows, 'missing fields still reject the entire malformed response')
    assert.deepEqual(JSON.parse(JSON.stringify(cfg.listLogs(200))), raw, 'reads never normalize, delete or modify stored values')
  } finally { reader.cancel() }
} finally { (cfg as any).db.close() }

const onlyMissing = parseRuntimeLogs([{ id: 1, ts: '', level: null, source: null, message: null }])
assert.equal(filterRuntimeLogs(onlyMissing, null, 'null').length, 0)
for (const field of ['level', 'source', 'message']) for (const bad of [0, false, [], {}, undefined]) assert.throws(() => parseRuntimeLogs([{ id: 1, ts: '', level: null, source: null, message: null, [field]: bad }]), InvalidRuntimeLogs)
assert.throws(() => parseRuntimeLogs([{ id: 1, ts: null, level: null, source: null, message: null }]), InvalidRuntimeLogs, 'timestamp remains required as in the stored schema')
const presentation = parseRuntimeLogs([
  { id: 5, ts: '', level: null, source: null, message: null },
  { id: 4, ts: '', level: '', source: '', message: '' },
  { id: 3, ts: '', level: 'null', source: 'null', message: 'null' },
  { id: 2, ts: '', level: 'all', source: '', message: '' },
  { id: 1, ts: '', level: 'missing', source: '', message: '' },
])
for (const english of [false, true]) {
  const html = renderToStaticMarkup(createElement(RuntimeLogsView, { state: { phase: 'ready', rows: presentation, receivedAt: '2026-11-07T00:00:00Z' }, refresh() {}, english }))
  for (const text of english ? ['level not recorded', 'source not recorded', 'message not recorded', 'empty level', 'empty source', 'empty message'] : ['未记录级别', '未记录来源', '未记录消息', '空级别', '空来源', '空消息']) assert(html.includes(text))
  for (const value of ['missing', 'level:missing', 'all', 'level:all', 'level:', 'level:null']) assert(html.includes(`value="${value}"`), 'missing, empty and literal option values cannot collide')
  assert(html.includes('>null</td>'), 'literal null strings remain visible as text')
}
console.log('RUNTIME LOG NULL OK: original schema memory repro, 54 nullable/empty/literal combinations, lossless immutable JSON, source/message/level display and distinct missing-level filter, no synthetic null search matches, malformed fields still rejected and stale snapshot retained; no real data, clears, services, model, browser or hardware')
