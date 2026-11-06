import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'
import { registerRecordingAttention } from '../packages/api/src/recording-attention.ts'
import { parseRecordingIntervalStatus } from '../packages/core/src/recording-attention.ts'
import { RecordingAttentionRead } from '../apps/web/src/recording-attention-read.ts'
import { RecordingIntervalStatusView } from '../apps/web/src/RecordingIntervalNotice.tsx'

const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify(), device = cfg.createObject('synthetic <script>', 'mock.invalid', 502), other = cfg.createObject('other', 'other.mock.invalid', 502)
const recorder = new Recorder({ on() {} }, cfg)
let unavailable = false, readError = false, malformed = false
registerRecordingAttention(app, () => unavailable ? null : { getRecordingIntervalStatus: id => { if (readError) throw new Error('SYNTHETIC-PRIVATE-DETAIL'); return malformed ? { ...recorder.getRecordingIntervalStatus(id), deviceId: 999 } : recorder.getRecordingIntervalStatus(id) } })
const get = async (url: string) => { const r = await app.inject({ url }); if (r.statusCode !== 200) throw new Error('read failed'); return r.json() }
const route = '/api/monitor_objects/' + device.id + '/recording-interval-status'
const timers = new Map<number, () => void>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout
let nextTimer = 0
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
let snapshot: any
try {
  const live = recorder.startRecording(device.id, 10, 60000)
  assert.equal((recorder.getRecordingIntervalStatus(device.id) as any).active.length, 1)
  const logsBefore = cfg.listLogs().length
  const configuration = () => JSON.stringify({ ...cfg.exportBackup(), createdAt: 'fixed' })
  const before = configuration()
  snapshot = (await app.inject({ url: route })).json()
  assert.equal(snapshot.current.intervalMs, 10); assert.equal(snapshot.notices.length, 0); assert.equal(cfg.listLogs().length, logsBefore)
  assert.equal(configuration(), before, 'inspection does not write configuration or invalidate ownership')
  recorder.stopRecording(live); assert.equal(recorder.getRecording(live)!.intervalRestore, 'restored')
  const id = recorder.startRecording(device.id, 10, 60000)
  cfg.updateObject(device.id, { pollIntervalMs: 55 }); timers.get(nextTimer)!()
  assert.equal(recorder.getRecording(id)!.status, 'done'); assert.equal(recorder.getRecording(id)!.intervalRestore, 'preserved')
  recorder.deleteRecording(id); assert.equal(recorder.getRecording(id), null)
  snapshot = (await app.inject({ url: route })).json()
  assert.equal(snapshot.current.intervalMs, 55); assert.equal(snapshot.notices[0].recordingId, id); assert.equal(snapshot.notices[0].originalIntervalMs, 1000)
  assert.equal(snapshot.notices[0].recordingIntervalMs, 10); assert.equal(snapshot.active.length, 0)
  assert(cfg.listLogs().some(row => row.level === 'WARN' && row.source === 'recorder' && row.message.includes(id)), 'timed attention also reaches existing logs')
  const count = snapshot.notices.length; recorder.stopRecording(id)
  assert.equal((recorder.getRecordingIntervalStatus(device.id) as any).notices.length, count, 'no duplicate completion notices')
  const protectedCopy: any = recorder.getRecordingIntervalStatus(device.id)
  assert.throws(() => protectedCopy.notices[0].warnings.push('mutated'))

  // Simulate another device; no record/alias of that device is included in the selected-device response.
  const foreign = recorder.startRecording(other.id, 10, 60000); cfg.updateObject(other.id, { pollIntervalMs: 33 }); recorder.stopRecording(foreign)
  assert(!(recorder.getRecordingIntervalStatus(device.id) as any).notices.some((row: any) => row.deviceId === other.id))
  const first = recorder.startRecording(device.id, 10, 60000); cfg.updateObject(device.id, { pollIntervalMs: 55 }); recorder.stopRecording(first)
  for (let i = 0; i < 51; i++) { const next = recorder.startRecording(device.id, 10, 60000); cfg.updateObject(device.id, { pollIntervalMs: 55 }); recorder.stopRecording(next) }
  assert.equal(recorder.getRecording(first), null, 'sample retention evicts older sessions')
  assert((recorder.getRecordingIntervalStatus(device.id) as any).notices.some((row: any) => row.recordingId === first), 'attention survives sample retention')
  for (let i = 0; i < 52; i++) { const next = recorder.startRecording(device.id, 10, 60000); cfg.updateObject(device.id, { pollIntervalMs: 55 }); recorder.stopRecording(next) }
  const capped: any = recorder.getRecordingIntervalStatus(device.id)
  assert.equal(capped.notices.length, 100); assert(capped.retention.dropped > 0); assert.equal(capped.retention.scope, 'process')
  assert.equal(recorder.listRecordings().length, 50)
  cfg.deleteObject(other.id)
  assert.equal((recorder.getRecordingIntervalStatus(other.id) as any).current, null)
  // Failure to write the diagnostic log must not discard the in-memory notice or turn done into an exception.
  const failId = recorder.startRecording(device.id, 10, 60000), restore = cfg.restoreRecordingInterval.bind(cfg), log = cfg.log.bind(cfg)
  cfg.restoreRecordingInterval = (() => { throw new Error('synthetic restore failure') }) as any
  cfg.log = (() => { throw new Error('synthetic log failure') }) as any
  assert.doesNotThrow(() => recorder.stopRecording(failId)); cfg.restoreRecordingInterval = restore; cfg.log = log
  const uncertain: any = recorder.getRecordingIntervalStatus(device.id)
  assert.equal(uncertain.notices[0].state, 'uncertain'); assert(uncertain.notices[0].warnings.some((message: string) => message.includes('日志未保存')))
  assert.equal((new Recorder({ on() {} }, cfg).getRecordingIntervalStatus(device.id) as any).notices.length, 0, 'a new engine does not infer previous-process issues from current numeric equality')
  const scoped = new ConfigStore({ dbPath: ':memory:' }), scopeRecorder = new Recorder({ on() {} }, scoped)
  try {
    const d = scoped.createObject('old scope', 'mock.invalid', 502), old = scopeRecorder.startRecording(d.id, 10, 60000)
    scoped.updateObject(d.id, { pollIntervalMs: 55 }); scopeRecorder.stopRecording(old)
    assert.equal((scopeRecorder.getRecordingIntervalStatus(d.id) as any).notices.length, 1)
    const active = scopeRecorder.startRecording(d.id, 10, 60000)
    scoped.reopen(':memory:'); const replacement = scoped.createObject('new scope', 'mock.invalid', 502, 'master', { pollIntervalMs: 10 })
    assert.equal(replacement.id, d.id)
    assert.equal((scopeRecorder.getRecordingIntervalStatus(d.id) as any).active.length, 0)
    assert.equal((scopeRecorder.getRecordingIntervalStatus(d.id) as any).notices.length, 0)
    scopeRecorder.stopRecording(active)
    assert.equal((scopeRecorder.getRecordingIntervalStatus(d.id) as any).notices.length, 0, 'old completion cannot be attributed to a replacement device with the same ID')
    assert.equal(scoped.listLogs().length, 0); assert.equal(scoped.getObject(d.id)!.pollIntervalMs, 10)
  } finally { for (const session of scopeRecorder.listRecordings()) scopeRecorder.stopRecording(session.id); (scoped as any).db.close() }
  assert.equal(timers.size, 0)
} finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear }

try {
  for (const id of ['0', '-1', '1e0', '9007199254740992']) assert.equal((await app.inject({ url: '/api/monitor_objects/' + id + '/recording-interval-status' })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: route, payload: { restore: true } })).statusCode, 404, 'the new endpoint has no write action')
  unavailable = true; assert.deepEqual((await app.inject({ url: route })).json(), { available: false, deviceId: device.id }); unavailable = false
  readError = true; let result = await app.inject({ url: route }); readError = false
  assert.equal(result.statusCode, 500); assert(!result.body.includes('PRIVATE'))
  malformed = true; result = await app.inject({ url: route }); malformed = false; assert.equal(result.statusCode, 500)
  snapshot = (await app.inject({ url: route })).json()
  for (const bad of [null, {}, { ...snapshot, deviceId: other.id }, { ...snapshot, checkedAt: Infinity }, { ...snapshot, current: { ...snapshot.current, intervalMs: '10' } }, { ...snapshot, notices: [{ ...snapshot.notices[0], deviceId: other.id }] }, { ...snapshot, retention: { ...snapshot.retention, scope: 'all-time' } }]) assert.throws(() => parseRecordingIntervalStatus(bad, device.id), /响应无效/)

  const reader = new RecordingAttentionRead(device.id); let updates = 0
  const unsubscribe = reader.subscribe(() => updates++)
  await reader.refresh(get); assert.equal(reader.getSnapshot().phase, 'ready')
  const previous = reader.getSnapshot().value
  readError = true; await reader.refresh(get); readError = false
  assert.equal(reader.getSnapshot().phase, 'error'); assert.equal(reader.getSnapshot().value, previous)
  let late!: (value: unknown) => void
  const old = reader.refresh(async () => new Promise(resolve => { late = resolve }))
  await Promise.resolve(); await reader.refresh(async () => ({ ...snapshot, current: { ...snapshot.current, intervalMs: 77 } }))
  late(snapshot); await old
  assert.equal((reader.getSnapshot().value as any).current.intervalMs, 77, 'late replies never replace the newest check')
  await reader.refresh(async () => new Promise(() => {}), 5); assert.equal(reader.getSnapshot().phase, 'error'); assert.equal((reader.getSnapshot().value as any).current.intervalMs, 77)
  await reader.refresh(get); assert.equal(reader.getSnapshot().phase, 'ready')
  let cancelled!: (value: unknown) => void
  const pending = reader.refresh(async () => new Promise(resolve => { cancelled = resolve }))
  await Promise.resolve(); reader.cancel(); const atCancel = updates; cancelled(snapshot); await pending; assert.equal(updates, atCancel); unsubscribe()
  const render = (state: any) => renderToStaticMarkup(createElement(RecordingIntervalStatusView, { state, refresh() { throw new Error('no requests during SSR') } }))
  const html = render({ phase: 'ready', value: snapshot })
  assert.match(html, /需要人工核对/); assert.match(html, /原间隔/); assert.match(html, /录制间隔/); assert.match(html, /当前配置间隔/); assert.match(html, /上方的设备编辑入口/)
  assert.equal((html.match(/<button/g) ?? []).length, 1, 'only the read control is offered')
  assert.match(render({ phase: 'error', value: snapshot }), /上次读取/); assert.match(render({ phase: 'error', value: snapshot }), /未核实/)
  assert.match(render({ phase: 'ready', value: { available: false, deviceId: device.id } }), /未提供录制状态/)
  assert.match(render({ phase: 'ready', value: { ...snapshot, notices: [], current: null } }), /设备已不存在/)
  assert.match(render({ phase: 'ready', value: { ...snapshot, current: { ...snapshot.current, intervalMs: 0 } } }), /配置值异常/)
  const escaped = render({ phase: 'ready', value: { ...snapshot, notices: [{ ...snapshot.notices[0], warnings: ['<script>long</script>'] }] } })
  assert(!escaped.includes('<script>')); assert(escaped.includes('&lt;script&gt;'))
  console.log('RECORDING ATTENTION OK: timer warning visibility, sample deletion/eviction independence, bounded/global coverage, device isolation, log failure, no-write API/absent service/errors, immutable strict response, latest/cancel/timeout/recovery, safe existing-editor guidance and SSR; memory/mock only, no DOM or hardware')
} finally { await app.close(); for (const session of recorder.listRecordings()) recorder.stopRecording(session.id); (cfg as any).db.close() }
