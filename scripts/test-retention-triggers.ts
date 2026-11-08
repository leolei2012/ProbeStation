import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DuckDBInstance } from '@duckdb/node-api'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { GlobalRetentionView } from '../apps/web/src/GlobalRetentionSettings.tsx'
import { RetentionSummary } from '../apps/web/src/RetentionSummary.tsx'

const errors: unknown[] = []; let passed = 0
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('RETENTION TRIGGERS OK:', name) }
  catch (error) { errors.push(error); console.error('RETENTION TRIGGERS FAILED:', name, error) }
}
for (const english of [false, true]) await check('visible setting/summary trigger explanation: ' + (english ? 'English' : 'Chinese'), async () => {
  let actions = 0
  const expected = english ? [
    'Setting the cleanup interval to 0 only stops the timer.',
    'Startup, reopening history storage and changing global retention can still schedule cleanup.',
    'Setting global retention to 0 does not override a positive device retention; pausing a device does not stop history cleanup.',
    'The current backend cleanup interval has not been read.',
  ] : [
    '周期清理间隔设为 0 只停定时任务。',
    '启动、重开历史库或修改全局保留时长仍可安排清理。',
    '全局设为 0 不会覆盖设备的独立正数保留期；设备暂停也不停止历史清理。',
    '未读取当前后台清理周期',
  ]
  const props = { draft: '0', custom: false, acknowledged: false, onDraft() { actions++ }, onCustom() { actions++ }, onAcknowledge() { actions++ }, read() { actions++ }, apply() { actions++ }, english }
  for (const state of [
    { phase: 'reading', seconds: null, outcome: 'none' },
    { phase: 'read-error', seconds: null, outcome: 'none' },
    { phase: 'ready', seconds: 0, outcome: 'none' },
    { phase: 'saving', seconds: 600, outcome: 'none' },
    { phase: 'ready', seconds: 600, outcome: 'uncertain' },
  ] as const) {
    const html = renderToStaticMarkup(createElement(GlobalRetentionView, { ...props, state }))
    for (const text of expected) assert(html.includes(text), 'settings must explain ' + text)
  }
  for (const retention of [undefined, { retention_seconds: 0 }, { retention_seconds: 0, policy: { version: 1, objectId: 1, source: 'device', seconds: 60 } }]) {
    const html = renderToStaticMarkup(createElement(RetentionSummary, { retention, objectId: 1, english }))
    for (const text of expected) assert(html.includes(text), 'summary must explain ' + text)
    assert(!html.includes('<button') && !html.includes('<input'), 'rules are read-only; no extra deletion controls')
  }
  assert.equal(actions, 0)
})

await check('synthetic file: interval 0 has no timer but startup/reopen/set/manual triggers retain original scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probestation-retention-triggers-')), path = join(dir, 'synthetic.duckdb')
  const cfg = new ConfigStore({ dbPath: ':memory:' }), now = Date.parse('2026-11-08T12:00:00Z'), savedNow = Date.now
  let store: DuckDBStore | undefined
  Date.now = () => now
  try {
    const device = cfg.createObject('synthetic paused positive override', 'mock.invalid', 502, 'master', { dataRetainSeconds: 60 })
    cfg.updateObject(device.id, { isActive: 0 })
    const db = await DuckDBInstance.create(path), conn = await db.connect()
    try {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      await conn.run("INSERT INTO poll_data VALUES (1, 0, TIMESTAMP '2026-11-08 11:58:59', 1, 'good'), (1, 0, TIMESTAMP '2026-11-08 11:59:00', 2, 'good')")
    } finally { conn.closeSync(); db.closeSync() }
    store = new DuckDBStore({ dbPath: path, retentionSeconds: 0, retentionCheckMs: 0, flushIntervalMs: 0, flushBatchSize: 1000 }, cfg)
    const settled = async () => { await (store as any).ready; await Promise.resolve(); await (store as any).mutations }
    const values = async () => (await store!.queryObject(1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).map(row => row.rawValue).sort((a, b) => a - b)
    const expired = async (rawValue: number) => { store!.write([{ objectId: 1, area: 'holding-register', address: 0, rawValue, timestamp: '2026-11-08T11:58:59Z', quality: 'good' }]); await store!.flush() }
    await settled(); assert.equal((store as any).retentionTimer, null); assert.deepEqual(await values(), [2])
    await expired(3); assert.deepEqual(await values(), [2, 3], 'without a timer, flush alone does not clean up')
    await store.reopen(path); await settled(); assert.deepEqual(await values(), [2])
    await expired(4); store.setRetentionSeconds(0); await settled(); assert.deepEqual(await values(), [2])
    await expired(5); await store.cleanup(); assert.deepEqual(await values(), [2])
    for (const dataRetainSeconds of [0, null]) {
      cfg.updateObject(device.id, { dataRetainSeconds }); await expired(dataRetainSeconds === 0 ? 6 : 7)
      await store.reopen(path); await settled(); await store.cleanup()
    }
    assert.deepEqual(await values(), [2, 6, 7], 'global 0 plus device 0/NULL preserves history across these triggers')
  } finally {
    Date.now = savedNow
    await store?.close(); await cfg.close()
    const inside = relative(realpathSync(tmpdir()), realpathSync(dir))
    assert(inside && inside.startsWith('probestation-retention-triggers-') && !inside.startsWith('..') && !inside.includes(':'))
    rmSync(dir, { recursive: true, force: true })
  }
})
if (errors.length) throw new AggregateError(errors, `${errors.length} retention trigger cases failed; ${passed} passed`)
console.log(`RETENTION TRIGGERS TEST OK: ${passed} cases, bilingual production SSR + synthetic storage only`)
