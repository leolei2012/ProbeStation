import assert from 'node:assert/strict'
import { boot } from './_bootstrap.ts'

// No API listener, simulator, or poller.startAll: this test never contacts a device.
const { ctx } = await boot()
const cfg = ctx.get('config', false)
const d = cfg.createObject('history precision fixture', '127.0.0.1', 8502)
const store = ctx.get('store', false)
const timestamps = ['2026-10-06T00:00:00.100Z', '2026-10-06T00:00:00.200Z']
store.write(timestamps.flatMap((timestamp, i) => [
  { objectId: d.id, area: 'holding-register' as const, address: 0, timestamp, rawValue: i + 1, quality: 'good' },
  { objectId: d.id, area: 'holding-register' as const, address: 1, timestamp, rawValue: i + 10, quality: 'good' },
]))
await store.flush()
const words = await store.queryWithOffset(d.id, 0, timestamps[0], timestamps[1], 'holding-register', 500)
assert.equal(words.length, 2)
assert.equal(words[0].timestampMs, Date.parse(timestamps[0]))
assert.equal(words[1].timestampMs, Date.parse(timestamps[1]))
const secondPage = await store.queryWithOffset(d.id, 0, timestamps[0], timestamps[1], 'holding-register', 1, 1)
assert.equal(secondPage[0].timestampMs, Date.parse(timestamps[1]))
console.log('ASSISTANT HISTORY TEST OK: millisecond timestamps survive DuckDB and pagination')
process.exit(0)
