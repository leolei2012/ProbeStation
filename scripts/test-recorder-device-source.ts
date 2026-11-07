import assert from 'node:assert/strict'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'
import type { DeviceRecord } from '../packages/config/src/index.ts'

const sample = (value: number) => ({ area: 'holding-register', address: 0, slaveId: 1, rawValue: value, timestamp: new Date().toISOString(), quality: 'good', batchId: 'mock-' + value })
const timers = new Map<number, () => void>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout
let nextTimer = 0
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
function scenario(events: boolean, extra: Partial<DeviceRecord>, run: (cfg: ConfigStore, recorder: Recorder, id: number, send: (value: number, id?: number) => void, listeners: Map<string, (value: any) => void>) => void) {
  const listeners = new Map<string, (value: any) => void>()
  const cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => { if (events) listeners.get('config/changed')?.({ scope, id }) })
  const device = cfg.createObject('synthetic source', 'first.mock.invalid', 502, 'master', extra)
  const recorder = new Recorder({ on(event: string, fn: any) { listeners.set(event, fn) } }, cfg)
  try { run(cfg, recorder, device.id, (value, id = device.id) => listeners.get('poller/result')!({ objectId: id, points: [sample(value)] }), listeners) }
  finally { for (const recording of recorder.listRecordings()) recorder.deleteRecording(recording.id); assert.equal(timers.size, 0); assert.equal(recorder.getSampleStorageStatus().retainedSamples, 0); (cfg as any).db.close() }
}
const start = (recorder: Recorder, id: number) => recorder.startRecording(id, 10, 60000)
try {
  scenario(false, {}, (cfg, recorder, deviceId, send) => {
    const id = start(recorder, deviceId); send(1)
    cfg.updateObject(deviceId, { ip: 'second.mock.invalid' }); send(2)
    const rec = recorder.getRecording(id)!
    assert.deepEqual(rec.samples.map(point => point.rawValue), [1], 'new-connection results must not be appended to the original recording')
    assert.equal(rec.completionReason, 'source-changed'); assert.equal(rec.intervalRestore, 'preserved'); assert.equal(cfg.getObject(deviceId)!.pollIntervalMs, 10)
    assert.equal((recorder.getRecordingIntervalStatus(deviceId) as any).notices[0].recordingId, id)
    assert(!JSON.stringify(rec).includes('second.mock.invalid'), 'private source conditions are not leaked into the recording payload')
  })
  for (const change of [{ ip: 'second.mock.invalid' }, { port: 1502 }, { slaveId: 7 }, { transport: 'rtu', serialPath: 'MOCK-PORT' }, { mode: 'slave', ip: '127.0.0.1', port: 1502 }]) scenario(true, {}, (cfg, recorder, id, send) => {
    const a = start(recorder, id), b = start(recorder, id); send(1)
    cfg.updateObject(id, change)
    assert.equal(recorder.getRecording(a)!.status, 'done'); assert.equal(recorder.getRecording(b)!.completionReason, 'source-changed')
    send(2); assert.equal(recorder.getRecording(a)!.samples.length, 1); assert.equal(recorder.getRecording(b)!.samples.length, 1); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
  })
  scenario(false, {}, (cfg, recorder, id, send) => {
    const s = start(recorder, id); send(1); let restores = 0
    const restore = cfg.restoreRecordingInterval.bind(cfg); cfg.restoreRecordingInterval = lease => { restores++; return restore(lease) }
    cfg.updateObject(id, { ip: 'temporary.mock.invalid' }); cfg.updateObject(id, { ip: 'first.mock.invalid' }); send(2)
    assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(restores, 0, 'source ABA revokes the old rate lease even when its value snapshot would match again')
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
  })
  scenario(true, {}, (cfg, recorder, id, send, listeners) => {
    const s = start(recorder, id); send(1)
    cfg.updateObject(id, { name: 'renamed', pollIntervalMs: 55, timeoutMs: 1234, isActive: 0, dataRetainSeconds: 60, serialPath: 'UNUSED', baudRate: 19200, ip: 'first.mock.invalid', port: 502 })
    listeners.get('config/changed')!(undefined); listeners.get('config/changed')!({ scope: 'group', id: 1 })
    send(2); assert.equal(recorder.getRecording(s)!.status, 'recording'); assert.equal(recorder.getRecording(s)!.samples.length, 2)
    recorder.stopRecording(s); assert.equal(recorder.getRecording(s)!.completionReason, 'stopped'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 55)
  })
  for (const change of [{ serialPath: 'MOCK-SECOND' }, { baudRate: 19200 }, { parity: 'odd' }, { dataBits: 7 }, { stopBits: 2 }, { flowControl: 'rtscts' }]) scenario(true, { transport: 'rtu', serialPath: 'MOCK-FIRST' }, (cfg, recorder, id, send) => {
    const s = start(recorder, id); send(1); cfg.updateObject(id, { ip: 'unused.mock.invalid', port: 1502 }); send(2)
    assert.equal(recorder.getRecording(s)!.status, 'recording', 'inactive TCP fields do not change an RTU source')
    cfg.updateObject(id, change); send(3)
    assert.deepEqual(recorder.getRecording(s)!.samples.map(point => point.rawValue), [1, 2]); assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed')
  })
  scenario(true, {}, (cfg, recorder, id) => {
    const guard = cfg.captureRecordingSource(id)
    assert.equal(cfg.recordingSourceMatches({ ...guard }), false)
    cfg.updateObject(id, { ip: 'other.mock.invalid' })
    assert.throws(() => cfg.acquireRecordingInterval(id, 10, guard), error => (error as any).statusCode === 409)
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000)
    cfg.updateObject(id, { ip: 'first.mock.invalid' })
    assert.equal(cfg.recordingSourceMatches(guard), false)
    cfg.createGroup(id, 'mock', 3, 0, 1)
    const groups = cfg.listGroups.bind(cfg); let once = true
    cfg.listGroups = deviceId => { if (once) { once = false; cfg.updateObject(id, { ip: 'changed-during-prepare.mock.invalid' }) }; return groups(deviceId) }
    assert.throws(() => recorder.startRecording(id, 10, 60000, [{ area: 'holding-register', address: 0 }]), error => (error as any).statusCode === 409)
    assert.equal(recorder.listRecordings().length, 0); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000)
  })
  scenario(true, {}, (cfg, recorder, id) => {
    const acquire = cfg.acquireRecordingInterval.bind(cfg)
    cfg.acquireRecordingInterval = (deviceId, interval, source) => { const result = acquire(deviceId, interval, source); cfg.updateObject(id, { ip: 'after-acquire.mock.invalid' }); return result }
    const s = start(recorder, id); assert.equal(recorder.getRecording(s)!.status, 'done'); assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(timers.size, 0)
  })
  scenario(false, {}, (cfg, recorder, id, send) => {
    const a = start(recorder, id), other = cfg.createObject('other', 'other.mock.invalid', 502), b = start(recorder, other.id)
    send(1); send(3, other.id)
    const matches = cfg.recordingSourceMatches.bind(cfg); cfg.recordingSourceMatches = (() => { throw new Error('SYNTHETIC-PRIVATE-ERROR') }) as any
    send(2); cfg.recordingSourceMatches = matches
    assert.equal(recorder.getRecording(a)!.completionReason, 'source-unverified'); assert.equal(recorder.getRecording(b)!.status, 'recording'); assert(!JSON.stringify(recorder.getRecording(a)).includes('PRIVATE'))
    send(4, other.id); recorder.stopRecording(b); assert.equal(cfg.getObject(other.id)!.pollIntervalMs, 1000)
  })
  scenario(false, {}, (cfg, recorder, id, send) => {
    const s = start(recorder, id); send(1)
    ;(cfg as any).db.prepare('UPDATE monitor_objects SET ip=? WHERE id=?').run('outside-config-store.mock.invalid', id)
    send(2); assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(recorder.getRecording(s)!.samples.length, 1)
  })
  scenario(false, {}, (cfg, recorder, id, send) => {
    const s = start(recorder, id); send(1); cfg.updateObject(id, { ip: 'timer-check.mock.invalid' }); timers.get(nextTimer)!()
    assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
  })
  scenario(false, {}, (cfg, recorder, id, send) => {
    const s = recorder.startTriggerRecording(id, 10, 'holding-register', 0, '>', 10, 100, 100, undefined, 1)
    send(1); cfg.updateObject(id, { ip: 'changed-before-trigger.mock.invalid' })
    const logs = cfg.listLogs().length
    assert.equal((recorder.getRecordingIntervalStatus(id) as any).active.length, 1)
    assert.equal(cfg.listLogs().length, logs, 'read-only inspection does not stop a recording or write a source warning')
    send(100)
    assert.equal(recorder.getRecording(s)!.triggered, false); assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(recorder.getRecording(s)!.samples.length, 1)
  })
  scenario(true, {}, (cfg, recorder, id, send) => {
    const s = start(recorder, id); send(1); cfg.deleteObject(id); send(2)
    assert.equal(recorder.getRecording(s)!.completionReason, 'source-changed'); assert.equal(cfg.getObject(id), undefined)
  })
  console.log('RECORDER DEVICE SOURCE OK: actual mixing repro, TCP/RTU/role/slave source changes, local ABA, shared sessions, atomic prepare rejection, acquisition race, interval-only/metadata/inactive-field compatibility, failed reads, no-notification/raw-SQL changes, timer/delete checks and no old-period restoration; memory/mock only')
} finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear }
