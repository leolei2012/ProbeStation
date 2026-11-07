import { withMockRecordingIntervals } from './fixtures/recording-config.ts'
import assert from 'node:assert/strict'
import { Recorder } from '../packages/mcp/src/recorder.ts'

// Pure mocked events/configuration/clock; no listeners, devices, sockets or databases.
let now = Date.parse('2026-11-06T10:00:00Z'), callback: (event: any) => void = () => {}
const timers = new Map<number, () => void>(), originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = Date.now
let nextTimer = 0
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
Date.now = () => now
const device = { id: 1, mode: 'master', slaveId: 1, pollIntervalMs: 1000 }
const groups = [1, 2].map(id => ({ id, slaveId: id, functionCode: 3, startAddress: 0, quantity: 4 }))
const updates: number[] = []
const cfg = withMockRecordingIntervals({ getObject: (id: number) => id === 1 ? device : undefined, listGroups: () => groups, updateObject: (_id: number, fields: any) => { updates.push(fields.pollIntervalMs); Object.assign(device, fields) } })

const recorder = new Recorder({ on: (event: string, fn: any) => { if (event === 'poller/result') callback = fn } }, cfg)
const point = (slaveId: number | null | undefined, rawValue: number, extra: any = {}) => ({ objectId: 1, area: 'holding-register', address: 0, timestamp: new Date(now).toISOString(), rawValue, quality: 'good', slaveId, batchId: 'response-' + slaveId, ...extra })
const send = (points: any[], objectId = 1) => callback(JSON.parse(JSON.stringify({ objectId, points })))
const get = (id: string) => recorder.getRecording(id)!
const stopAll = () => { for (const r of recorder.listRecordings()) recorder.stopRecording(r.id) }
try {
  const selected = recorder.startRecording(1, 10, 10000, undefined, 1)
  send([point(2, 100), point(1, 5), point(null, 200)])
  assert.deepEqual(get(selected).samples.map(p => [p.slaveId, p.rawValue, p.batchId]), [[1, 5, 'response-1']], 'a selected recording must preserve and isolate source identity')
  send([point(1, 9)], 2); assert.equal(get(selected).samples.length, 1, 'device boundary is also required')
  recorder.stopRecording(selected); assert.equal(device.pollIntervalMs, 1000)
  const all = recorder.startRecording(1, 10, 10000)
  send([point(2, 100), point(1, 5), point(undefined, 200), point(null, 201), point(256, 7)])
  assert.deepEqual(get(all).samples.map(p => p.slaveId), [2, 1, null, null], 'all-source raw recording preserves unknown provenance, never defaults to 1')
  assert.ok(get(all).samples.slice(2).every(p => !p.sourceVerified))
  assert.equal(get(all).slaveId, null); recorder.stopRecording(all)

  // Ambiguous legacy selectors fail BEFORE any poll-rate mutation or session creation.
  const before = updates.length, count = recorder.listRecordings().length
  assert.throws(() => recorder.startRecording(1, 10, 10000, [{ area: 'holding-register', address: 0 }]), /source|slave/i)
  assert.throws(() => recorder.startTriggerRecording(1, 10, 'holding-register', 0, '>', 10, 100, 100), /source|slave/i)
  assert.equal(updates.length, before); assert.equal(recorder.listRecordings().length, count)
  const mixedSelection = recorder.startRecording(1, 10, 10000, [{ area: 'holding-register', address: 0, slaveId: 1 }, { area: 'holding-register', address: 0, slaveId: 2 }])
  send([point(1, 3), point(2, 8), point(null, 9), point(1, 9, { area: 'input-register' })])
  assert.deepEqual(get(mixedSelection).samples.map(p => [p.slaveId, p.rawValue]), [[1, 3], [2, 8]])
  recorder.stopRecording(mixedSelection)
  const defaults = recorder.startRecording(1, 10, 10000, [{ area: 'holding-register', address: 0 }, { area: 'holding-register', address: 1, slaveId: 2 }], 1)
  send([point(1, 2), point(2, 3), point(2, 4, { address: 1 })])
  assert.deepEqual(get(defaults).samples.map(p => [p.slaveId, p.rawValue]), [[1, 2], [2, 4]], 'address source overrides the recording default')
  recorder.stopRecording(defaults)

  // Trigger source can differ from recorded addresses; foreign/unknown/bad/duplicate input never fires.
  const armed = recorder.startTriggerRecording(1, 10, 'holding-register', 0, '>', 10, 100, 100, undefined, 1, 2)
  assert.equal(get(armed).trigger!.slaveId, 2)
  send([point(1, 100), point(null, 100)]); assert.equal(get(armed).triggered, false)
  send([point(2, 100, { quality: 'bad' })]); assert.equal(get(armed).triggered, false)
  send([point(2, 100), point(2, 101)]); assert.equal(get(armed).triggered, false, 'overlapping responses must not silently choose a first trigger value')
  send([point(2, 100, { timestamp: new Date(now - 1).toISOString() })]); assert.equal(get(armed).triggered, false, 'pre-arm values cannot fire a new recording')
  send([point(2, 100, { rawValue: NaN })]); assert.equal(get(armed).triggered, false)
  send([point(2, 100, { timestamp: 'invalid' })]); assert.equal(get(armed).triggered, false)
  send([point(2, 11)]); assert.equal(get(armed).triggered, true)
  assert.ok(get(armed).samples.every(p => p.slaveId === 1), 'trigger monitoring must not broaden the captured source selection')
  assert.equal(get(armed).triggeredBy!.slaveId, 2); assert.equal(get(armed).triggeredBy!.rawValue, 11)
  recorder.stopRecording(armed)
  const changed = recorder.startTriggerRecording(1, 10, 'holding-register', 0, 'changed', 0, 100, 100, undefined, 1)
  send([point(1, 5)]); now += 1; send([point(2, 9)]); assert.equal(get(changed).triggered, false)
  send([point(1, 9, { quality: 'bad' })]); now += 1; send([point(1, 9)]); assert.equal(get(changed).triggered, false, 'bad target samples reset the changed baseline')
  send([point(1, 10, { timestamp: new Date(now - 1).toISOString() })]); assert.equal(get(changed).triggered, false, 'out-of-order source values cannot fire changed')
  now += 1; send([point(1, 10)]); assert.equal(get(changed).triggered, true)
  recorder.stopRecording(changed)

  // Omitted source remains convenient only when current configuration is unambiguous.
  groups.splice(1)
  const inferred = recorder.startTriggerRecording(1, 10, 'holding-register', 0, '>', 10, 100, 100, [{ area: 'holding-register', address: 0 }])
  assert.equal(get(inferred).trigger!.slaveId, 1); assert.equal(get(inferred).addresses![0].slaveId, 1)
  groups[0].slaveId = 2
  send([point(2, 20), point(null, 20)]); assert.equal(get(inferred).triggered, false, 'resolved source stays pinned when config changes')
  now += 1; send([point(1, 20)]); assert.equal(get(inferred).triggered, true)
  recorder.stopRecording(inferred); groups[0].slaveId = 1
  device.mode = 'slave'; device.slaveId = 7
  const local = recorder.startTriggerRecording(1, 10, 'input-register', 10, '==', 1, 100, 100)
  assert.equal(get(local).trigger!.slaveId, 7)
  send([point(7, 1, { area: 'input-register', address: 10, batchId: undefined })]); assert.equal(get(local).triggered, true, 'a single raw word from known local slave memory needs no fabricated response ID')
  recorder.stopRecording(local); device.mode = 'master'; device.slaveId = 1

  // Sessions on one device share a rate lease; last stop restores the original, not another session's rate.
  const a = recorder.startRecording(1, 10, 10000, undefined, 1), b = recorder.startRecording(1, 10, 10000, undefined, 2)
  assert.throws(() => recorder.startRecording(1, 20, 10000), /interval|recording/i)
  recorder.stopRecording(a); assert.equal(device.pollIntervalMs, 10)
  recorder.stopRecording(b); assert.equal(device.pollIntervalMs, 1000)
  const edited = recorder.startRecording(1, 10, 10000); device.pollIntervalMs = 55; recorder.stopRecording(edited)
  assert.equal(device.pollIntervalMs, 55, 'stop must preserve a subsequent user change'); device.pollIntervalMs = 1000
  // The timer callback still finishes and restores a normal session.
  const timed = recorder.startRecording(1, 10, 10000), finish = timers.get(nextTimer)!
  finish(); assert.equal(get(timed).status, 'done'); assert.equal(device.pollIntervalMs, 1000)
  for (const bad of [-1, 256, 1.5, '1']) {
    assert.throws(() => recorder.startRecording(1, 10, 10000, undefined, bad as any))
    assert.throws(() => recorder.startTriggerRecording(1, 10, 'holding-register', 0, '>', 1, 0, 1, undefined, undefined, bad as any))
  }
  for (const selector of [{ area: 'other', address: 0 }, { area: 'holding-register', address: -1 }, { area: 'holding-register', address: 65536 }]) assert.throws(() => recorder.startRecording(1, 10, 10000, [selector], 1))
  for (const operator of ['bogus', '']) assert.throws(() => recorder.startTriggerRecording(1, 10, 'holding-register', 0, operator, 1, 0, 1, undefined, 1))
  for (const size of [-1, 1.5, NaN, Infinity, 2 ** 31]) assert.throws(() => recorder.startTriggerRecording(1, 10, 'holding-register', 0, '>', 1, size, 100, undefined, 1))
  for (const bad of [null, '2', -1]) assert.throws(() => recorder.startRecording(1, 10, 10000, [{ area: 'holding-register', address: 0, slaveId: bad as any }], 1))
  for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) for (const [op, threshold] of [['>', 6], ['<', 8], ['>=', 7], ['<=', 7], ['==', 7], ['!=', 8]] as const) {
    const id = recorder.startTriggerRecording(1, 10, area, 0, op, threshold, 0, 100, undefined, 1)
    send([point(2, 7, { area })]); assert.equal(get(id).triggered, false)
    send([point(1, 7, { area })]); assert.equal(get(id).triggered, true); recorder.stopRecording(id)
  }
  // Retention never evicts an active session (which owns a rate/timer).
  const active = Array.from({ length: 50 }, () => recorder.startRecording(1, 10, 10000))
  const writes = updates.length
  assert.throws(() => recorder.startRecording(1, 10, 10000), /active recordings/)
  assert.equal(updates.length, writes); assert.equal(get(active[0]).status, 'recording')
  for (const id of active) recorder.stopRecording(id)
  assert.equal(device.pollIntervalMs, 1000)
} finally { stopAll(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; Date.now = originalNow }
console.log('RECORDER SOURCE OK: explicit/all/per-address sources, NULL metadata, ambiguity before mutation, source-safe raw triggers/changed/recovery, pinned inference, local slave, concurrent rate restoration and input validation (mock only)')
