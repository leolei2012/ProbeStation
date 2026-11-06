import assert from 'node:assert/strict'
import { readAlarmValue, readPointAlarmValue } from '../apps/web/src/alarm-value.ts'
import { sourceKey, sourceSample } from '../packages/core/src/sample-source.ts'
import { alarmMatches } from '../packages/core/src/alarm.ts'
import { decodeRegister, encodeRegister } from '../packages/core/src/codec.ts'
import type { Sample } from '../apps/web/src/observation.ts'

// Hot-cache contract: overlapping sources retain only source-scoped keys.
const now = Date.parse('2026-11-06T00:00:00.000Z'), device = { id: 1, isActive: 1, mode: 'master', slaveId: 9 }
const reg = { dataType: 'uint16', functionCode: 3, startAddress: 0 }
const sample = (slaveId: number, rawValue: number): Sample => ({ slaveId, rawValue, timestamp: new Date(now).toISOString(), quality: 'good', batchId: 'batch-' + slaveId })
const latest = { [sourceKey(1, 'holding-register', 0, 1)]: sample(1, 10), [sourceKey(1, 'holding-register', 0, 2)]: sample(2, 200) }
assert.equal(readPointAlarmValue(reg, latest, device, { isActive: 1, slaveId: 2 }, now, 5000, false), 200, 'top alarm must use the same source-scoped snapshot as the live row')
const read = (cache: Record<string, Sample>, source = 2, overrides: Partial<typeof device> = {}) => readPointAlarmValue(reg, cache, { ...device, ...overrides }, { isActive: 1, slaveId: source }, now, 5000, false)
assert.equal(read(latest, 1), 10)
assert.equal(alarmMatches(read(latest), '>', 100), true)
assert.equal(alarmMatches(read(latest, 1), '>', 100), false)
const before = JSON.stringify(latest)
const plain = '1:holding-register:0'
assert.equal(read({ [plain]: sample(1, 200) }), null, 'another source cannot trigger the selected rule through a compatibility key')
assert.equal(read({ [plain]: sample(1, 10) }), null, 'another source cannot report a false normal state')
assert.equal(read({ [plain]: sample(2, 200) }), 200, 'legacy key is accepted only when it explicitly identifies the configured source')
assert.equal(read({ [plain]: { ...sample(2, 200), slaveId: null } }), null, 'source-unknown legacy values are not assigned to a configured slave')
assert.equal(read({ [sourceKey(1, 'holding-register', 0, 2)]: sample(1, 200) }), null, 'key and metadata must agree')
assert.equal(read({ [sourceKey(2, 'holding-register', 0, 2)]: sample(2, 200) }), null, 'devices remain isolated')
for (const slaveId of [undefined, NaN, -1, 256]) assert.equal(readPointAlarmValue(reg, latest, device, { isActive: 1, slaveId }, now, 5000, false), null)
const local = { ...latest, [sourceKey(1, 'holding-register', 0, 7)]: sample(7, 300) }
assert.equal(read(local, 2, { mode: 'slave', slaveId: 7 }), 300, 'local slave uses device ID instead of group metadata')
assert.equal(read(local, 2, { mode: 'slave', slaveId: NaN }), null)
assert.equal(read(latest, 2, { isActive: 0 }), null)
assert.equal(readPointAlarmValue(reg, latest, device, { isActive: 0, slaveId: 2 }, now, 5000, false), null)
assert.equal(readPointAlarmValue(reg, latest, device, { isActive: 1, slaveId: 2 }, now, 5000, true), null)
for (const [functionCode, area] of [[1, 'coil'], [2, 'discrete-input'], [3, 'holding-register'], [4, 'input-register']] as const) {
  const cache = { ...latest, [sourceKey(1, area, 0, 2)]: sample(2, 1) }
  assert.equal(readPointAlarmValue({ ...reg, functionCode }, cache, device, { isActive: 1, slaveId: 2 }, now, 5000, false), 1)
}
for (const dataType of ['uint32', 'uint32-LE', 'uint64', 'uint64-LE']) {
  const words = encodeRegister(dataType, dataType.includes('64') ? 1152921504606846976n : 65536)
  const cache: Record<string, Sample> = {}
  for (const [i, rawValue] of words.entries()) cache[sourceKey(1, 'holding-register', i, 2)] = { ...sample(2, rawValue), batchId: 'complete' }
  // Wrong-source compatibility entries must not fill partial target words.
  for (const i of words.keys()) cache['1:holding-register:' + i] = sample(1, 65535)
  const value = () => readPointAlarmValue({ ...reg, dataType }, cache, device, { isActive: 1, slaveId: 2 }, now, 5000, false)
  assert.equal(value(), decodeRegister(dataType, words))
  const rowValue = readAlarmValue(dataType, words.map((_, i) => sourceSample(cache, 1, 'holding-register', i, 2)), now, 5000, false, false)
  assert.equal(value(), rowValue, 'top-panel value agrees with the existing live-row source/quality/batch path')
  const key = sourceKey(1, 'holding-register', words.length - 1, 2), good = cache[key]
  for (const replacement of [undefined, { ...good, batchId: 'another-response' }, { ...good, slaveId: 1 }, { ...good, quality: 'bad' }, { ...good, timestamp: new Date(now - 6000).toISOString() }, { ...good, timestamp: new Date(now + 2000).toISOString() }, { ...good, rawValue: NaN }]) {
    if (replacement) cache[key] = replacement; else delete cache[key]
    assert.equal(value(), null, 'partial/mixed/corrupt/stale/future data remains unknown, without fallback to other sources')
  }
  cache[key] = good; assert.equal(value(), decodeRegister(dataType, words), 'a complete valid target batch restores evaluation')
}
assert.equal(JSON.stringify(latest), before, 'alarm evaluation never modifies cached data')
console.log('ALARM SOURCE OK: top-panel/live-row parity, explicit source/device/area isolation, false-trigger/false-normal prevention, local slave, 32/64-bit BE/LE, missing/mixed/stale/bad/future data and recovery; pure snapshots only')
