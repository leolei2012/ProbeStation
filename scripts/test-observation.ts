import assert from 'node:assert/strict'
import { pointHealth, sampleTime, staleAfterMs } from '../apps/web/src/observation.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'

const now = Date.parse('2026-09-23T04:00:00Z')
const sample = { rawValue: 3, quality: 'good', timestamp: new Date(now).toISOString() }
assert.equal(pointHealth([sample], now, 5000, false, false).stale, false)
assert.equal(pointHealth([sample], now + 6000, 5000, false, false).stale, true)
assert.equal(pointHealth([sample], now, 5000, true, false).stale, true)
assert.equal(pointHealth([sample], now, 5000, false, true).stale, true)
assert.equal(pointHealth([{ ...sample, quality: 'bad' }], now, 5000, false, false).stale, true)
assert.equal(pointHealth([undefined], now, 5000, false, false).timestamp, null)
assert.equal(pointHealth([sample, undefined], now, 5000, false, false).missing, true)
assert.equal(pointHealth([sample, { ...sample, timestamp: new Date(now - 10000).toISOString() }], now, 5000, false, false).stale, true)
assert.equal(sampleTime({ ...sample, timestamp: '2026-09-23 12:00:00', timestampMs: now }), now)
assert.equal(staleAfterMs(1000, 3000, [{ isActive: 1, quantity: 250, functionCode: 3 }, { isActive: 0, quantity: 10000, functionCode: 3 }]), 16000)

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 500, retentionSeconds: 0, retentionCheckMs: 60000 })
store.write([{ ...sample, objectId: 1, area: 'holding-register', address: 0 }])
assert.equal(store.getLatest()['1:holding-register:0'].timestampMs, now)
assert.equal(store.getLatestByObject(1, 'holding-register')[0].timestampMs, now)
assert.equal(store.getLatestByObjectAll(1)['holding-register:0'].timestampMs, now)
console.log('OBSERVATION TEST OK: aging, pauses, faults, multiword values, polling thresholds and snapshot timestamps')
process.exit(0)
