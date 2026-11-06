import assert from 'node:assert/strict'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { apply } from '../packages/mcp/src/index.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'

// Register production read handlers without opening any socket or loading real services.
const handlers = new Map<string, (args: any) => Promise<any>>()
const schemas = new Map<string, any>()
let recordingEvent: (payload: any) => void = () => {}
const recordingDevice = { id: 1, mode: 'master', pollIntervalMs: 1000 }
const rateChanges: number[] = []
let factory: (() => McpServer) | undefined, listens = 0, ambiguous = true
const groups = [1, 2].map(id => ({ id, slaveId: id, functionCode: 3, startAddress: 0, quantity: 2 }))
const regs = groups.map(g => ({ id: g.id, groupId: g.id, startAddress: 0, functionCode: 3, dataType: 'uint32' }))
let latest: Record<string, any> = {}
let rows: any[] = []
let queriedSource: number | undefined
const cfg = { getObject: () => recordingDevice, listGroups: () => groups, listRegistersByObject: () => ambiguous ? regs : [regs[0]], updateObject: (_id: number, fields: any) => { rateChanges.push(fields.pollIntervalMs); Object.assign(recordingDevice, fields) }, log: () => {} }
const store = {
  getLatestByObjectAll: () => latest,
  getLatestByObject: (_id: number, area: string, slaveId?: number) => Object.fromEntries([0, 1].flatMap(address => {
    const p = latest[sourceKey('', area, address, slaveId ?? null)]
    return p ? [[address, p]] : []
  })),
  queryWithOffset: async (_id: number, _addr: number, _start: string, _end: string, _area: string, _limit: number, _offset: number, slaveId?: number) => { queriedSource = slaveId; return rows },
}
const originalCreate = http.createServer, originalRegister = McpServer.prototype.registerTool
try {
  http.createServer = (() => ({ listen: () => { listens++ } })) as any
  McpServer.prototype.registerTool = function (name: string, config: any, callback: any) { handlers.set(name, callback); schemas.set(name, config.inputSchema); return {} as any } as any
  const ctx = { config: cfg, store, poller: {}, on: (name: string, fn: any) => { if (name === 'poller/result') recordingEvent = fn }, provide: (_name: string, service: any) => { factory = service.createServer } }
  apply(ctx as any, { host: '127.0.0.1', port: 0 })
  const server = factory!(); await server.close()
} finally { http.createServer = originalCreate; McpServer.prototype.registerTool = originalRegister }
assert.equal(listens, 1, 'listen was intercepted, no server or transport was actually started')
const args = { device_id: 1, area: 'holding-register', address: 0, start: '2026-11-06T00:00:00Z', end: '2026-11-06T00:01:00Z' }
const run = async (name: string, input: any = args) => handlers.get(name)!(input)
const body = (response: any) => JSON.parse(response.content[0].text)
for (const id of [1, 2]) for (const address of [0, 1]) latest[sourceKey('', 'holding-register', address, id)] = { rawValue: address ? id * 5 : 0, timestamp: args.start, quality: 'good', slaveId: id, batchId: 'same' }
let out = body(await run('get_device_snapshot'))
assert.deepEqual(out.map((p: any) => [p.slave_id, p.value, p.automatic_eligible]), [[1, 5, true], [2, 10, true]])
for (const tool of ['read_register', 'query_history']) assert.equal((await run(tool)).isError, true, 'address-only tools must refuse ambiguous configured sources')
ambiguous = false
out = body(await run('read_register')); assert.equal(out.value, 5); assert.equal(out.slave_id, 1)
latest[sourceKey('', 'holding-register', 1, 1)].timestamp = args.end
assert.equal(body(await run('read_register')).value, null, 'cached words with different times are not coherent')
latest[sourceKey('', 'holding-register', 1, 1)].timestamp = args.start
latest[sourceKey('', 'holding-register', 1, 1)].batchId = 'other'
assert.equal(body(await run('read_register')).automatic_eligible, false)
latest = { 'holding-register:0': { rawValue: 7, timestamp: args.start, quality: 'good' } }
assert.equal(body(await run('get_device_snapshot'))[0].value, null, 'unknown legacy source never fills a known-source snapshot')
// Raw multiword history is deliberately unavailable for automatic evaluation.
rows = [{ ts: args.start, rawValue: 1, quality: 'good', batchId: 'X', slaveId: 1 }]
out = body(await run('query_history'))
assert.equal(queriedSource, 1); assert.equal(out.points[0].value, null); assert.equal(out.points[0].slave_id, 1)
regs[0].dataType = 'uint16'
out = body(await run('query_history')); assert.equal(out.points[0].value, 1); assert.equal(out.points[0].automatic_eligible, true)
rows[0].slaveId = null
out = body(await run('query_history')); assert.equal(out.points[0].value, null); assert.equal(out.points[0].verification, 'unknown', 'overlapping current groups make legacy source ambiguous')
groups.splice(1)
out = body(await run('query_history')); assert.equal(out.points[0].value, null); assert.equal(out.points[0].compatibility_value, '1'); assert.equal(out.points[0].verification, 'unverified')

// Production MCP argument mapping, with only mocked config/event handlers and no transport.
groups.push({ id: 2, slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2 })
const recArgs = { device_id: 1, interval_ms: 10, duration_ms: 600000 }
const triggerArgs = { device_id: 1, interval_ms: 10, trigger_area: 'holding-register', trigger_address: 0, operator: '>', threshold: 10, before_ms: 10000, after_ms: 600000 }
const eventPoint = (slaveId: number | null, rawValue: number) => ({ objectId: 1, area: 'holding-register', address: 0, timestamp: new Date().toISOString(), slaveId, rawValue, quality: 'good', batchId: 'recording-' + slaveId })
try {
  const before = rateChanges.length
  assert.equal((await run('start_recording', { ...recArgs, addresses: [{ area: 'holding-register', address: 0 }] })).isError, true)
  assert.equal((await run('start_trigger_recording', triggerArgs)).isError, true)
  assert.equal(rateChanges.length, before, 'ambiguous MCP requests must not change configuration')
  const result = body(await run('start_recording', { ...recArgs, slave_id: 1, addresses: [{ area: 'holding-register', address: 0, slave_id: 2 }] }))
  assert.equal(result.slave_id, 1); assert.equal(result.addresses[0].slaveId, 2)
  recordingEvent({ objectId: 1, points: [eventPoint(1, 5), eventPoint(2, 100), eventPoint(null, 200)] })
  let recording = body(await run('get_recording', { recording_id: result.recording_id }))
  assert.deepEqual(recording.samples.map((p: any) => [p.slaveId, p.rawValue, p.batchId]), [[2, 100, 'recording-2']])
  await run('stop_recording', { recording_id: result.recording_id }); assert.equal(recordingDevice.pollIntervalMs, 1000)
  const armed = body(await run('start_trigger_recording', { ...triggerArgs, slave_id: 1, trigger_slave_id: 2 }))
  assert.equal(armed.trigger.slaveId, 2)
  recordingEvent({ objectId: 1, points: [eventPoint(1, 100), eventPoint(null, 100)] })
  assert.equal(body(await run('get_recording', { recording_id: armed.recording_id })).triggered, false)
  recordingEvent({ objectId: 1, points: [eventPoint(2, 11)] })
  recording = body(await run('get_recording', { recording_id: armed.recording_id }))
  assert.equal(recording.triggered, true); assert.equal(recording.triggeredBy.slaveId, 2)
  assert.ok(recording.samples.every((p: any) => p.slaveId === 1))
  const listed = body(await run('list_recordings')).find((r: any) => r.id === armed.recording_id)
  assert.equal(listed.slaveId, 1); assert.equal(listed.trigger.slaveId, 2)
  await run('stop_recording', { recording_id: armed.recording_id }); assert.equal(recordingDevice.pollIntervalMs, 1000)
  for (const tool of ['start_recording', 'start_trigger_recording']) {
    const schema = schemas.get(tool)
    assert.ok(schema.slave_id.safeParse(2).success)
    for (const invalid of [-1, 256, 1.5, '1', null]) assert.equal(schema.slave_id.safeParse(invalid).success, false)
    assert.ok(schema.addresses.safeParse([{ area: 'holding-register', address: 0, slave_id: 2 }]).success)
  }
  assert.equal((await run('start_recording', { ...recArgs, slave_id: 256 })).isError, true)
  assert.equal((await run('start_trigger_recording', { ...triggerArgs, trigger_slave_id: 1, operator: 'invalid' })).isError, true)
} finally {
  for (const recording of body(await run('list_recordings'))) await run('stop_recording', { recording_id: recording.id })
}
console.log('MCP SOURCE OK: production read-handler registry mocked without listeners; separate snapshots, ambiguous address refusal, missing/mixed cache, source-filtered raw history and NULL compatibility')
console.log('MCP RECORDING SOURCE OK: schema/parameter mapping, selection/error-before-mutation, source-specific trigger and capture, provenance/JSON/list/stop; no sockets or real config')
