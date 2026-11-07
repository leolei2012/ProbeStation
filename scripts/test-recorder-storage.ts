import assert from 'node:assert/strict'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Recorder, DEFAULT_RECORDING_SAMPLE_LIMITS, type RecordingSampleLimits } from '../packages/mcp/src/recorder.ts'

const timers = new Map<number, () => void>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout, clock = Date.now
let nextTimer = 0, now = Date.parse('2026-11-06T23:00:00Z')
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
Date.now = () => now
const point = (rawValue: number, address = 0, slaveId: number | null = 1, timestamp = new Date(now).toISOString()) => ({ area: 'holding-register', address, timestamp, rawValue, quality: 'good', slaveId, batchId: 'synthetic' })
function scenario(limits: Partial<RecordingSampleLimits>, run: (cfg: ConfigStore, recorder: Recorder, id: number, send: (points: any[], deviceId?: number) => void) => void) {
  const cfg = new ConfigStore({ dbPath: ':memory:' }), device = cfg.createObject('synthetic storage', 'mock.invalid', 502)
  let receive: (event: any) => void = () => {}
  const recorder = new Recorder({ on(event: string, fn: any) { if (event === 'poller/result') receive = fn } }, cfg, limits)
  try { run(cfg, recorder, device.id, (points, deviceId = device.id) => receive({ objectId: deviceId, points })) }
  finally {
    for (const session of recorder.listRecordings()) recorder.deleteRecording(session.id)
    assert.equal(recorder.getSampleStorageStatus().retainedSamples, 0); assert.equal(timers.size, 0); (cfg as any).db.close()
  }
}
const start = (recorder: Recorder, id: number) => recorder.startRecording(id, 10, 60000)
try {
  scenario({}, (cfg, recorder, deviceId, send) => {
    const id = start(recorder, deviceId)
    send(Array.from({ length: 200001 }, (_, i) => point(i % 65536, i % 65536)))
    const rec = recorder.getRecording(id)!
    assert.equal(rec.samples.length, 200000, 'a recording must not retain more than the documented raw-sample limit')
    assert.equal(rec.status, 'done'); assert.equal(rec.completionReason, 'sample-limit'); assert.equal(rec.quotaTruncated, true); assert.equal(rec.discardedSamples, 1)
    assert.equal(rec.intervalRestore, 'restored'); assert.equal(cfg.getObject(deviceId)!.pollIntervalMs, 1000)
    assert.deepEqual(recorder.getSampleStorageStatus(), { ...DEFAULT_RECORDING_SAMPLE_LIMITS, retainedSamples: 200000, remainingSamples: 300000 })
    send([point(5), point(6)]); assert.equal(rec.samples.length, 200000); assert.equal(rec.discardedSamples, 1, 'future unobserved/ignored events are not claimed in the known discarded count')
    assert(cfg.listLogs().some(log => log.level === 'WARN' && log.message.includes('样本上限')))
  })
  scenario({ maxSamplesPerSession: 4, maxTotalSamples: 5 }, (cfg, recorder, id, send) => {
    const a = start(recorder, id), b = start(recorder, id)
    send([point(1), point(2), point(3)])
    assert.equal(recorder.getRecording(a)!.samples.length, 3); assert.equal(recorder.getRecording(b)!.samples.length, 2)
    assert.equal(recorder.getRecording(b)!.completionReason, 'storage-limit'); assert.equal(recorder.getRecording(b)!.intervalRestore, 'shared'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
    assert.equal(recorder.getSampleStorageStatus().retainedSamples, 5)
    assert.throws(() => start(recorder, id), /容量已满.*删除已结束录制/); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
    send([point(4)]); assert.equal(recorder.getRecording(a)!.completionReason, 'storage-limit'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000)
    assert.throws(() => start(recorder, id), /容量已满/); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000, 'a rejected start cannot leave a temporary rate when only completed recordings fill storage')
    recorder.deleteRecording(b); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 3)
    const c = start(recorder, id); send([point(5), point(6), point(7)])
    assert.equal(recorder.getRecording(c)!.samples.length, 2); assert.equal(recorder.getRecording(c)!.discardedSamples, 1)
    assert.deepEqual(recorder.getRecording(a)!.samples.map(p => p.rawValue), [1, 2, 3], 'capacity never silently deletes earlier completed samples')
  })
  scenario({ maxSamplesPerSession: 2, maxTotalSamples: 4 }, (_cfg, recorder, id, send) => {
    const s = recorder.startRecording(id, 10, 60000, undefined, 1)
    send([point(1, 0, 2), point(2, 0, null)]); send([point(2)], id + 1); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 0)
    send([point(3), point(4)]); assert.equal(recorder.getRecording(s)!.status, 'recording', 'exact limit with no rejected sample does not falsely claim truncation')
    timers.get(nextTimer)!(); const rec = recorder.getRecording(s)!
    assert.equal(rec.completionReason, 'duration'); assert.equal(rec.quotaTruncated, false); assert.equal(rec.discardedSamples, 0)
    recorder.stopRecording(s); assert.equal(rec.completionReason, 'duration')
  })
  scenario({ maxSamplesPerSession: 5, maxTotalSamples: 5 }, (cfg, recorder, id, send) => {
    const other = cfg.createObject('other storage device', 'mock.invalid', 502), a = start(recorder, id), b = start(recorder, other.id)
    send([point(1), point(2), point(3)]); send([point(4), point(5), point(6)], other.id)
    assert.equal(recorder.getSampleStorageStatus().retainedSamples, 5); assert.equal(recorder.getRecording(b)!.completionReason, 'storage-limit')
    assert.equal(cfg.getObject(other.id)!.pollIntervalMs, 1000); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
    send([point(7)]); assert.equal(recorder.getRecording(a)!.completionReason, 'storage-limit'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000)
  })
  scenario({ maxSamplesPerSession: 2, maxTotalSamples: 3 }, (_cfg, recorder, id, send) => {
    const s = recorder.startTriggerRecording(id, 10, 'holding-register', 0, '>', 1000, 10, 100, undefined, 1)
    send([point(1), point(2)]); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 2)
    now += 20; send([point(3), point(4, 0, 1, 'invalid')])
    assert.equal(recorder.getSampleStorageStatus().retainedSamples, 1); assert.equal(recorder.getRecording(s)!.status, 'recording', 'expired/invalid pretrigger samples cannot cause a false full-buffer stop')
    now++; send([point(4), point(5)])
    assert.equal(recorder.getRecording(s)!.completionReason, 'sample-limit'); assert.equal(recorder.getRecording(s)!.samples.length, 2)
  })
  scenario({ maxSamplesPerSession: 1, maxTotalSamples: 3 }, (_cfg, recorder, id, send) => {
    const s = recorder.startTriggerRecording(id, 10, 'holding-register', 0, '>', 10, 100, 100, [{ area: 'holding-register', address: 1, slaveId: 1 }], 1)
    send([point(5, 1), point(20)])
    assert.equal(recorder.getRecording(s)!.triggered, true); assert.equal(recorder.getRecording(s)!.quotaTruncated, false)
    timers.get(nextTimer)!(); assert.equal(recorder.getRecording(s)!.completionReason, 'trigger-window')
    recorder.deleteRecording(s)
    const partial = recorder.startTriggerRecording(id, 10, 'holding-register', 0, '>', 10, 100, 100, [{ area: 'holding-register', address: 1, slaveId: 1 }], 1)
    send([point(5, 1), point(6, 1), point(20)])
    assert.equal(recorder.getRecording(partial)!.triggered, true); assert.equal(recorder.getRecording(partial)!.completionReason, 'sample-limit'); assert.equal(timers.size, 0, 'quota completion cancels the newly installed posttrigger timer')
    recorder.deleteRecording(partial)
    const timeout = recorder.startTriggerRecording(id, 10, 'holding-register', 0, '>', 10, 100, 100, undefined, 1)
    timers.get(nextTimer)!(); assert.equal(recorder.getRecording(timeout)!.completionReason, 'trigger-timeout'); assert.equal(recorder.getRecording(timeout)!.triggered, false)
  })
  scenario({ maxSamplesPerSession: 1, maxTotalSamples: 3 }, (cfg, recorder, id, send) => {
    const s = start(recorder, id); cfg.updateObject(id, { pollIntervalMs: 55 }); send([point(1), point(2)])
    assert.equal(recorder.getRecording(s)!.intervalRestore, 'preserved'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 55)
    assert((recorder.getRecordingIntervalStatus(id) as any).notices[0].warnings.some((message: string) => message.includes('样本上限')))
    recorder.deleteRecording(s)
    const failedLog = start(recorder, id), log = cfg.log.bind(cfg); cfg.log = (() => { throw new Error('synthetic log failure') }) as any
    assert.doesNotThrow(() => send([point(1), point(2)])); cfg.log = log
    assert.equal(recorder.getRecording(failedLog)!.completionReason, 'sample-limit'); assert(recorder.getRecording(failedLog)!.warnings.some(message => message.includes('日志未保存')))
  })
  scenario({ maxSamplesPerSession: 10, maxTotalSamples: 1000 }, (_cfg, recorder, id, send) => {
    const ids: string[] = []
    for (let index = 0; index < 52; index++) { const s = start(recorder, id); ids.push(s); send([point(index)]); recorder.stopRecording(s) }
    assert.equal(recorder.listRecordings().length, 50); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 50); assert.equal(recorder.getRecording(ids[0]), null)
    recorder.deleteRecording(ids[2]); assert.equal(recorder.deleteRecording(ids[2]), false); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 49)
  })
  scenario({ maxSamplesPerSession: 4, maxTotalSamples: 8 }, (cfg, recorder, id, send) => {
    const old = start(recorder, id); send([point(3)]); const lateTimer = timers.get(nextTimer)!
    cfg.reopen(':memory:'); const replacement = cfg.createObject('replacement', 'mock.invalid', 502, 'master', { pollIntervalMs: 77 })
    assert.equal(replacement.id, id)
    const current = start(recorder, id); send([point(7)])
    assert.equal(recorder.getRecording(old)!.completionReason, 'configuration-changed'); assert.deepEqual(recorder.getRecording(old)!.samples.map(p => p.rawValue), [3])
    assert.deepEqual(recorder.getRecording(current)!.samples.map(p => p.rawValue), [7]); lateTimer(); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
    recorder.stopRecording(current); assert.equal(cfg.getObject(id)!.pollIntervalMs, 77)
    const deleted = start(recorder, id); recorder.deleteRecording(deleted); assert.equal(recorder.getRecording(deleted), null)
  })
  const cfg = new ConfigStore({ dbPath: ':memory:' }); let subscriptions = 0
  try {
    for (const limits of [null, [], { unknown: 1 }, { maxSamplesPerSession: 0 }, { maxSamplesPerSession: 1.5 }, { maxTotalSamples: -1 }, { maxTotalSamples: Infinity }, { maxSamplesPerSession: '4' }]) assert.throws(() => new Recorder({ on() { subscriptions++ } }, cfg, limits as any), /invalid recording sample limits/)
    assert.equal(subscriptions, 0)
  } finally { (cfg as any).db.close() }
  let switching!: ConfigStore, flip = false
  switching = new ConfigStore({ dbPath: ':memory:' }, () => { if (flip) { flip = false; switching.reopen(':memory:'); switching.createObject('replacement during notification', 'mock.invalid', 502, 'master', { pollIntervalMs: 77 }) } })
  const source = switching.createObject('original', 'mock.invalid', 502), reentrant = new Recorder({ on() {} }, switching)
  try {
    flip = true; const id = start(reentrant, source.id)
    assert.equal(reentrant.getRecording(id)!.completionReason, 'configuration-changed'); assert.equal(reentrant.getRecording(id)!.status, 'done')
    assert.equal(timers.size, 0); assert.equal(switching.getObject(source.id)!.pollIntervalMs, 77); assert.equal(switching.listLogs().length, 0)
  } finally { for (const session of reentrant.listRecordings()) reentrant.deleteRecording(session.id); (switching as any).db.close() }
  let deleting!: ConfigStore, owner!: Recorder, currentId = '', deleteOnNotify = false
  deleting = new ConfigStore({ dbPath: ':memory:' }, () => { if (deleteOnNotify) { deleteOnNotify = false; owner.deleteRecording(currentId) } })
  const deletionDevice = deleting.createObject('reentrant delete', 'mock.invalid', 502)
  let deletionEvent: (event: any) => void = () => {}
  owner = new Recorder({ on(event: string, fn: any) { if (event === 'poller/result') deletionEvent = fn } }, deleting, { maxSamplesPerSession: 4, maxTotalSamples: 8 })
  try {
    currentId = start(owner, deletionDevice.id); deletionEvent({ objectId: deletionDevice.id, points: [point(1)] })
    deleteOnNotify = true; owner.deleteRecording(currentId)
    assert.equal(owner.getSampleStorageStatus().retainedSamples, 0); assert.equal(owner.getSampleStorageStatus().remainingSamples, 8); assert.equal(owner.getRecording(currentId), null)
  } finally { for (const session of owner.listRecordings()) owner.deleteRecording(session.id); (deleting as any).db.close() }
  console.log('RECORDER STORAGE OK: production 200001 boundary, shared/global quotas, exact/no-match cases, known discarded count, pretrigger pruning, independent triggers/timers, guarded restoration, log failure, eviction/delete accounting, configuration-scope termination and strict isolated limits; memory/mock only')
} finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; Date.now = clock }
