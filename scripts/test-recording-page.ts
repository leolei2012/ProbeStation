import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Recorder, DEFAULT_RECORDING_PAGE_SIZE, MAX_RECORDING_PAGE_SIZE } from '../packages/mcp/src/recorder.ts'
import { apply } from '../packages/mcp/src/index.ts'

const timers = new Map<number, () => void>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout
let nextTimer = 0
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
const cfg = new ConfigStore({ dbPath: ':memory:' }), device = cfg.createObject('synthetic pages', 'mock.invalid', 502)
let emit: (event: any) => void = () => {}
const recorder = new Recorder({ on(event: string, fn: any) { if (event === 'poller/result') emit = fn } }, cfg)
const point = (value: number) => ({ area: 'holding-register', address: value % 4, timestamp: new Date().toISOString(), rawValue: value, quality: value % 11 ? 'good' : 'bad', slaveId: value % 5 ? 1 : null, batchId: value % 7 ? 'batch-' + value : null })
const status = (code: number) => (error: any) => error?.statusCode === code
try {
  const id = recorder.startRecording(device.id, 10, 60000)
  emit({ objectId: device.id, points: Array.from({ length: 2503 }, (_, index) => point(index)) })
  const activeCount = recorder.getRecording(id)!.samples.length
  assert.throws(() => recorder.getRecordingPage(id), error => status(409)(error) && (error as any).code === 'RECORDING_NOT_FINISHED')
  assert.equal(recorder.getRecording(id)!.status, 'recording'); assert.equal(cfg.getObject(device.id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(id)!.samples.length, activeCount)
  recorder.stopRecording(id)
  const before = JSON.stringify(cfg.listObjects()), logs = cfg.listLogs().length, storage = recorder.getSampleStorageStatus()
  const first = recorder.getRecordingPage(id)
  assert.equal(first.samples.length, DEFAULT_RECORDING_PAGE_SIZE); assert.equal(first.limit, 200); assert.equal(first.totalSamples, 2503); assert.equal(first.nextOffset, 200); assert.equal(first.coverage, 'retained-samples-only')
  assert.equal(first.recording.completionReason, 'stopped'); assert.equal(first.recording.quotaTruncated, false); assert.equal(first.configurationScopeCurrent, true)
  assert(!Object.hasOwn(first.recording, 'samples')); assert.equal(first.samples[0].slaveId, null); assert.equal(first.samples[0].batchId, null); assert.equal(first.samples[0].sourceVerified, false)
  assert.equal(recorder.getRecordingPage(id).snapshotId, first.snapshotId, 'retrying the first read does not change the retained-data identity')
  const collected = [...first.samples]; let page = first
  while (page.nextOffset !== null) { page = recorder.getRecordingPage(id, page.nextOffset, 333, first.snapshotId); assert.equal(page.snapshotId, first.snapshotId); collected.push(...page.samples) }
  assert.equal(page.hasMore, false); assert.equal(page.nextOffset, null); assert.deepEqual(collected, recorder.getRecording(id)!.samples, 'all pages preserve original order, NULL identity and quality without gaps/duplicates')
  assert.equal(JSON.stringify(cfg.listObjects()), before); assert.equal(cfg.listLogs().length, logs); assert.deepEqual(recorder.getSampleStorageStatus(), storage)
  assert(JSON.stringify(first).length < JSON.stringify(recorder.getRecording(id)).length / 5, 'the page does not serialize the full retained array')
  assert.throws(() => (first.samples[0] as any).rawValue = -1); assert.throws(() => (first.recording.warnings as any).push('changed'))
  assert.equal(recorder.getRecording(id)!.samples[0].rawValue, 0)
  assert.equal(recorder.getRecordingPage(id, 2503, 1, first.snapshotId).returnedSamples, 0)
  assert.equal(recorder.getRecordingPage(id, 0, MAX_RECORDING_PAGE_SIZE).samples.length, 1000)
  for (const [offset, limit, token] of [[-1, 1, undefined], [0.5, 1, undefined], [Infinity, 1, undefined], [2504, 1, first.snapshotId], [0, 0, undefined], [0, 1001, undefined], [0, 1.5, undefined], [0, 1, 'bad-token']]) assert.throws(() => recorder.getRecordingPage(id, offset as number, limit as number, token as any), status(400))
  assert.throws(() => recorder.getRecordingPage(id, 1), status(428))
  assert.throws(() => recorder.getRecordingPage(id, 1, 1, randomUUID()), status(409))
  const empty = recorder.startRecording(device.id, 10, 60000); recorder.stopRecording(empty)
  const emptyPage = recorder.getRecordingPage(empty)
  assert.equal(emptyPage.totalSamples, 0); assert.equal(emptyPage.hasMore, false); assert.deepEqual(emptyPage.samples, [])
  assert.throws(() => recorder.getRecordingPage(empty, 0, 1, first.snapshotId), status(409), 'a cursor cannot be reused for another recording')
  recorder.deleteRecording(id); assert.throws(() => recorder.getRecordingPage(id, 200, 200, first.snapshotId), status(404))
  const old = recorder.startRecording(device.id, 10, 60000); emit({ objectId: device.id, points: [point(3)] }); recorder.stopRecording(old)
  const oldPage = recorder.getRecordingPage(old)
  cfg.reopen(':memory:'); cfg.createObject('replacement', 'mock.invalid', 502)
  const afterReopen = recorder.getRecordingPage(old, 0, 200, oldPage.snapshotId)
  assert.equal(afterReopen.configurationScopeCurrent, false); assert.deepEqual(afterReopen.samples, oldPage.samples)
  for (let index = 0; index < 51; index++) { const next = recorder.startRecording(device.id, 10, 60000); recorder.stopRecording(next) }
  assert.throws(() => recorder.getRecordingPage(old, 0, 1, oldPage.snapshotId), status(404), 'retention cannot silently substitute another dataset')
  const limited = new Recorder({ on(event: string, fn: any) { if (event === 'poller/result') emit = fn } }, cfg, { maxSamplesPerSession: 2, maxTotalSamples: 3 })
  const partial = limited.startRecording(device.id, 10, 60000)
  emit({ objectId: device.id, points: [point(1), point(2), point(3)] })
  const partialPage = limited.getRecordingPage(partial)
  assert.equal(partialPage.hasMore, false); assert.equal(partialPage.recording.quotaTruncated, true); assert.equal(partialPage.recording.discardedSamples, 1); assert.equal(partialPage.recording.completionReason, 'sample-limit')
  const selected = limited.startTriggerRecording(device.id, 10, 'holding-register', 1, '>', 0, 100, 100, [{ area: 'holding-register', address: 1, slaveId: 1 }], 1)
  emit({ objectId: device.id, points: [point(1)] }); timers.get(nextTimer)!()
  const selectedPage = limited.getRecordingPage(selected)
  assert.equal(selectedPage.recording.triggered, true)
  assert.throws(() => (selectedPage.recording.addresses![0] as any).address = 100)
  assert.throws(() => (selectedPage.recording.triggeredBy as any).rawValue = 999)
  assert.equal(limited.getRecording(selected)!.triggeredBy!.rawValue, 1)
  for (const session of limited.listRecordings()) limited.deleteRecording(session.id)
} finally { for (const session of recorder.listRecordings()) recorder.deleteRecording(session.id); (cfg as any).db.close(); globalThis.setTimeout = set; globalThis.clearTimeout = clear }

// Real SDK Client/Server and production tool registration; HTTP listen is intercepted, not opened.
const memory = new ConfigStore({ dbPath: ':memory:' }), target = memory.createObject('SDK page mock', 'mock.invalid', 502)
const handlers = new Map<string, (args: any) => Promise<any>>(), create = http.createServer, register = McpServer.prototype.registerTool
let factory: (() => McpServer) | undefined, server: McpServer | undefined, receiver: (value: any) => void = () => {}, listens = 0
try {
  http.createServer = (() => ({ listen() { listens++ } })) as any
  McpServer.prototype.registerTool = function (name: string, options: any, callback: any) { handlers.set(name, callback); return (register as any).call(this, name, options, callback) } as any
  apply({ config: memory, store: {}, poller: {}, ota: {}, sink: {}, on(event: string, callback: any) { if (event === 'poller/result') receiver = callback }, provide(_name: string, service: any) { factory = service.createServer } } as any, { host: '127.0.0.1', port: 0 })
  server = factory!()
} finally { http.createServer = create; McpServer.prototype.registerTool = register }
const client = new Client({ name: 'recording-page-test', version: '1' }), transports = InMemoryTransport.createLinkedPair()
const body = (value: any) => JSON.parse(value.content[0].text)
let recordingId: string | undefined
try {
  await Promise.all([server!.connect(transports[0]), client.connect(transports[1])])
  const tools = await client.listTools(), tool = tools.tools.find(tool => tool.name === 'get_recording_page')!
  assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.destructiveHint, false)
  const started = body(await client.callTool({ name: 'start_recording', arguments: { device_id: target.id, interval_ms: 10, duration_ms: 60000 } })); recordingId = started.recording_id
  const call = (args: any) => client.callTool({ name: 'get_recording_page', arguments: { recording_id: recordingId!, ...args } })
  let reply = await call({}); assert.equal(reply.isError, true); assert.equal(body(reply).code, 'RECORDING_NOT_FINISHED')
  receiver({ objectId: target.id, points: [point(1), point(2)] })
  await client.callTool({ name: 'stop_recording', arguments: { recording_id: recordingId! } })
  const legacy = body(await client.callTool({ name: 'get_recording', arguments: { recording_id: recordingId! } })); assert.equal(legacy.id, recordingId); assert.equal(legacy.samples.length, 2); assert(!Object.hasOwn(legacy, 'snapshotId'))
  const first = body(await call({ limit: 1 })); assert.equal(first.samples.length, 1); assert.equal(first.nextOffset, 1)
  reply = await call({ offset: 1, limit: 1 }); assert.equal(reply.isError, true); assert.equal(body(reply).status, 428)
  const second = body(await call({ offset: first.nextOffset, limit: 1, snapshot_id: first.snapshotId })); assert.equal(second.samples[0].rawValue, 2); assert.equal(second.hasMore, false)
  assert.equal((await call({ limit: 1001 })).isError, true); assert.equal((await call({ snapshot_id: 'invalid' })).isError, true)
  const scope = memory.getRecordingIntervalScope.bind(memory); memory.getRecordingIntervalScope = (() => { throw new Error('SYNTHETIC-PRIVATE-ERROR') }) as any
  try { reply = await call({}); assert.equal(reply.isError, true); assert.equal(body(reply).status, 500); assert(!JSON.stringify(reply).includes('PRIVATE')) } finally { memory.getRecordingIntervalScope = scope }
  await client.callTool({ name: 'delete_recording', arguments: { recording_id: recordingId! } })
  reply = await call({ offset: 1, snapshot_id: first.snapshotId }); assert.equal(reply.isError, true); assert.equal(body(reply).status, 404)
  assert.equal(listens, 1); assert.equal(memory.getObject(target.id)!.pollIntervalMs, 1000)
  console.log('RECORDING PAGE OK: bounded completed snapshots, ordered lossless paging/NULL provenance, strict limits/tokens, empty/partial/deleted/evicted/old-scope cases, immutable copies, no active stop or rate/log writes, legacy full response, and real SDK schema/errors/continuation over in-memory transport; no sockets or hardware')
} finally {
  if (recordingId) { try { await handlers.get('stop_recording')!({ recording_id: recordingId }) } catch {} }
  await client.close(); if (server) await server.close(); (memory as any).db.close()
}
