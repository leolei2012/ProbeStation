import assert from 'node:assert/strict'
import { apply } from '../packages/poller/src/index.ts'
import { decodeHistorySeries } from '../apps/web/src/history-curve.ts'
import { encodeRegister, decodeRegister } from '../packages/core/src/codec.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { apply as applyRules } from '../packages/rule/src/index.ts'

// No runtime bootstrap or driver imports: every protocol response is an in-process array.
const group = { id: 1, objectId: 1, functionCode: 3, startAddress: 0, quantity: 4, isActive: 1 }
const device = { id: 1, mode: 'master', transport: 'tcp', pollIntervalMs: 0 }
let engine: any
const captured: any[] = []
const driver = { isConnected: () => true, readHoldingRegisters: async () => [1, 2, 3, 4] }
const ctx: any = {
  on: () => {}, provide: (_name: string, value: any) => { engine = value },
  config: { getObject: () => device },
  store: { write: (points: any[]) => captured.push(...points) },
  emit: () => {},
}
apply(ctx, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
engine.drivers.set('tcp:1', driver); engine.groupsByDevice.set(1, [group])
const RealDate = Date
let tick = 0
const base = Date.parse('2026-10-28T00:00:00Z')
class TickDate extends RealDate { constructor() { super(base + tick++) } }
try {
  globalThis.Date = TickDate as DateConstructor
  await engine.pollNextGroup(device)
} finally { globalThis.Date = RealDate }
assert.equal(captured.length, 4)
assert.equal(new Set(captured.map(p => p.timestamp)).size, 1, 'one complete response must have one sample timestamp')
const reg = { id: 1, groupId: 1, startAddress: 0, dataType: 'uint32', functionCode: 3 }
const series = decodeHistorySeries([reg], captured.map(p => ({ ...p, ts: p.timestamp })), new Set([1]))
assert.equal(series[0]?.samples[0][1], 65538, 'history must retain the complete multiword response')
assert.equal(new Set(captured.map(p => p.batchId)).size, 1)
for (const fc of [3, 4]) for (const type of ['uint32', 'uint32-LE', 'uint64', 'uint64-LE']) for (const [before, after] of [[65536, 65535], [131071, 131072]]) {
  const width = type.includes('64') ? 4 : 2
  const definition = { startAddress: 124, dataType: type }
  ctx.config.listRegisters = () => [definition]
  let requests: { start: number; quantity: number }[] = []
  const read = async (start: number, quantity: number) => {
    requests.push({ start, quantity })
    const value = requests.length === 1 ? before : after
    const raw = encodeRegister(type, type.includes('64') ? BigInt(value) : value)
    return Array.from({ length: quantity }, (_, i) => raw[start + i - 124] ?? 0)
  }
  const result = await engine.readGroup({ readHoldingRegisters: read, readInputRegisters: read }, { ...group, functionCode: fc, quantity: 124 + width }, 0)
  assert.deepEqual(requests, [{ start: 0, quantity: 124 }, { start: 124, quantity: width }], 'chunk boundary must not split a multiword value')
  const words = result.filter((p: any) => p.address >= 124)
  assert.equal(new Set(words.map((p: any) => p.batchId)).size, 1)
  assert.notEqual(result[0].batchId, words[0].batchId)
  assert.equal(decodeRegister(type, words.map((p: any) => p.rawValue)), type.includes('64') ? BigInt(after) : after, 'changing values at the protocol boundary must never invent a third value')
}

// pollOnce intentionally emits one combined event. Earlier partial responses must not
// hide a complete response for the same register inside that event.
for (const fc of [3, 4]) for (const type of ['uint32', 'uint32-LE', 'uint64', 'uint64-LE']) {
  const value = type.includes('64') ? 65536n : 65536
  const raw = encodeRegister(type, value)
  const overlapRegister = { ...reg, functionCode: fc, dataType: type }
  let once: any, handler: (event: any) => void = () => {}, disconnects = 0
  const pollingEvents: any[] = [], alarms: any[] = []
  const read = async (_start: number, quantity: number) => quantity === 1 ? [1] : raw
  const context: any = {
    on: (name: string, fn: any) => { if (name === 'poller/result') handler = fn },
    provide: (name: string, service: any) => { if (name === 'poller') once = service },
    config: { listRules: () => [{ id: 1, registerId: overlapRegister.id, operator: '>', threshold: 65535 }], listRegistersByObject: () => [overlapRegister], log: () => {} },
    store: { write: () => {}, flush: async () => {} },
    modbus: { createDriver: () => ({ connect: async () => {}, disconnect: async () => { disconnects++ }, readHoldingRegisters: read, readInputRegisters: read }) },
    emit: (name: string, event: any) => {
      if (name === 'poller/result') { const wire = JSON.parse(JSON.stringify(event)); pollingEvents.push(wire); handler(wire) }
      if (name === 'rule/trigger') alarms.push(event)
    },
  }
  applyRules(context)
  apply(context, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
  await once.pollOnce({ id: 1, host: 'mock.invalid', port: 1502, groups: [{ ...group, functionCode: fc, quantity: 1 }, { ...group, id: 2, functionCode: fc, quantity: raw.length }] })
  assert.equal(pollingEvents.length, 1, 'preserve the combined pollOnce event contract')
  assert.equal(pollingEvents[0].points.length, raw.length + 1)
  assert.notEqual(pollingEvents[0].points[0].batchId, pollingEvents[0].points[1].batchId)
  assert.equal(alarms.length, 1, `complete ${type} FC${fc} response must not be masked by an earlier overlapping single-word response`)
  assert.equal(alarms[0].value, typeof value === 'bigint' ? String(value) : value)
  assert.equal(disconnects, 1)
}
const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
try {
  store.write(captured)
  const snapshot = JSON.parse(JSON.stringify(store.getLatestByObjectAll(1)))
  assert.equal(snapshot['holding-register:0'].batchId, captured[0].batchId, 'REST snapshot JSON retains response identity')
  assert.equal(store.getLatest()['1:holding-register:0'].batchId, captured[0].batchId, 'WS initial snapshot retains response identity')
  assert.equal(store.getLatestByObject(1, 'holding-register')[0].batchId, captured[0].batchId)
} finally { const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync() }
console.log('POLLER COHERENCE OK: response timestamps, aligned reads, live identity and pollOnce overlapping-group alarms for FC03/04 and 32/64-bit BE/LE')
