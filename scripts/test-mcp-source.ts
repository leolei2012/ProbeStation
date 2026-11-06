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
const groups = [1, 2].map(id => ({ id, objectId: 1, slaveId: id, functionCode: 3, startAddress: 0, quantity: 2 }))
const regs = groups.map(g => ({ id: g.id, groupId: g.id, objectId: 1, startAddress: 0, functionCode: 3, dataType: 'uint32' }))
let latest: Record<string, any> = {}
let rows: any[] = []
let queriedSource: number | undefined
let queryCalls = 0, cacheReads = 0
let imported: any[] = [], failImportLog = false
const cfg = { getObject: () => recordingDevice, listGroups: () => groups, listRegistersByObject: () => ambiguous ? regs : [regs[0]], updateObject: (_id: number, fields: any) => { rateChanges.push(fields.pollIntervalMs); Object.assign(recordingDevice, fields) }, log: () => { if (failImportLog) throw new Error('injected log failure') },
  importPoints: (_id: number, points: any[]) => { imported = points; return { updated: points.length, skipped: 0, errors: [], details: [], warnings: [] } } }
const store = {
  getLatestByObjectAll: () => latest,
  getLatestByObject: (_id: number, area: string, slaveId?: number) => { cacheReads++; return Object.fromEntries([0, 1].flatMap(address => {
    const p = latest[sourceKey('', area, address, slaveId ?? null)]
    return p ? [[address, p]] : []
  })) },
  queryWithOffset: async (_id: number, _addr: number, _start: string, _end: string, _area: string, _limit: number, _offset: number, slaveId?: number) => { queryCalls++; queriedSource = slaveId; return rows.filter(p => slaveId === undefined || p.slaveId == null || p.slaveId === slaveId) },
}
const originalCreate = http.createServer, originalRegister = McpServer.prototype.registerTool
try {
  http.createServer = (() => ({ listen: () => { listens++ } })) as any
  McpServer.prototype.registerTool = function (name: string, config: any, callback: any) { handlers.set(name, callback); schemas.set(name, config.inputSchema); return {} as any } as any
  const ctx = { config: cfg, store, poller: {}, sink: { importPointBook: async () => ({ groups: 1, registers: 2, errors: [], warnings: [] }) }, on: (name: string, fn: any) => { if (name === 'poller/result') recordingEvent = fn }, provide: (_name: string, service: any) => { factory = service.createServer } }
  apply(ctx as any, { host: '127.0.0.1', port: 0 })
  const server = factory!(); await server.close()
} finally { http.createServer = originalCreate; McpServer.prototype.registerTool = originalRegister }
assert.equal(listens, 1, 'listen was intercepted, no server or transport was actually started')
const args = { device_id: 1, area: 'holding-register', address: 0, start: '2026-11-06T00:00:00Z', end: '2026-11-06T00:01:00Z' }
const run = async (name: string, input: any = args) => handlers.get(name)!(input)
const body = (response: any) => JSON.parse(response.content[0].text)
// Production import argument mapping: the config boundary is mocked, no real mutation.
assert.equal(body(await run('import_points', { device_id: 1, points: [{ area: 'holding-register', address: 0, slave_id: 2, register_id: 2, alias: 'alias only' }] })).updated, 1)
assert.deepEqual([imported[0].slaveId, imported[0].registerId, imported[0].dataType, imported[0].unit, imported[0].enumMap, imported[0].factor], [2, 2, undefined, undefined, undefined, undefined])
await run('import_points', { device_id: 1, csv: '从站ID,寄存器地址,别名\n2,0,CSV' })
assert.deepEqual([imported[0].slaveId, imported[0].dataType, imported[0].unit, imported[0].enumMap, imported[0].factor], [2, undefined, undefined, undefined, undefined])
const parsedError = body(await run('import_points', { device_id: 1, csv: 'slave_id,address,alias\nwrong,0,unsafe' }))
assert.equal(parsedError.updated, 0); assert.equal(parsedError.parse.skipped, 1); assert.match(parsedError.parse.errors[0], /slaveId/)
try {
  failImportLog = true
  const logged = body(await run('import_points', { device_id: 1, points: [{ area: 'holding-register', address: 0, alias: 'processed' }] }))
  assert.equal(logged.updated, 1); assert.match(logged.warnings[0], /日志写入失败/)
} finally { failImportLog = false }
try {
  failImportLog = true
  const logged = body(await run('import_points_xlsx', { device_id: 1, content_b64: '' }))
  assert.equal(logged.groups, 1); assert.match(logged.warnings[0], /MCP日志写入失败/)
} finally { failImportLog = false }
await run('import_points', { device_id: 1, points: [{ area: 'holding-register', address: 0, unit: null, enum: null }] })
assert.equal(imported[0].unit, null); assert.equal(imported[0].enumMap, null)
const pointSchema = schemas.get('import_points').points
assert.equal(pointSchema.safeParse([{ area: 'holding-register', address: 0, slave_id: 2, register_id: 2, unit: null, enum: null }]).success, true)
for (const slave_id of [-1, 256, 1.5, '2', null]) assert.equal(pointSchema.safeParse([{ area: 'holding-register', address: 0, slave_id }]).success, false)
for (const id of [1, 2]) for (const address of [0, 1]) latest[sourceKey('', 'holding-register', address, id)] = { rawValue: address ? id * 5 : 0, timestamp: args.start, quality: 'good', slaveId: id, batchId: 'same' }
let out = body(await run('get_device_snapshot'))
assert.deepEqual(out.map((p: any) => [p.slave_id, p.value, p.automatic_eligible]), [[1, 5, true], [2, 10, true]])
for (const tool of ['read_register', 'query_history']) assert.equal((await run(tool)).isError, true, 'address-only tools must refuse ambiguous configured sources')
const ambiguity = body(await run('read_register'))
assert.equal(ambiguity.code, 'REGISTER_AMBIGUOUS'); assert.deepEqual(ambiguity.candidates.map((p: any) => [p.register_id, p.slave_id]), [[1, 1], [2, 2]])
const explicitSourceRead = await run('read_register', { ...args, slave_id: 2 })
assert.equal(explicitSourceRead.isError, undefined, 'an explicit source should make an otherwise ambiguous read usable')
assert.equal(body(explicitSourceRead).register_id, 2); assert.equal(body(explicitSourceRead).value, 10)
const beforeDiagnose = [cacheReads, queryCalls, rateChanges.length]
const diagnosis = body(await run('diagnose_points', { device_id: 1 }))
assert.equal(diagnosis.scope, 'point-table-structure'); assert.equal(diagnosis.summary.errors, 0)
assert.ok(diagnosis.issues.some((i: any) => i.code === 'IMPORT_MATCH_AMBIGUOUS'))
assert.deepEqual([cacheReads, queryCalls, rateChanges.length], beforeDiagnose, 'diagnostics only read configured definitions')
assert.equal((await run('diagnose_points', { device_id: 0 })).isError, true)
assert.equal(schemas.get('diagnose_points').device_id.safeParse(0).success, false)
assert.equal(body(await run('read_register', { ...args, register_id: 2 })).value, 10)
const semanticDuplicate = { ...regs[0], id: 99, factor: 2 }
regs.push(semanticDuplicate)
assert.equal((await run('read_register', { ...args, slave_id: 1 })).isError, true, 'same-source semantic definitions remain ambiguous')
assert.equal(body(await run('read_register', { ...args, slave_id: 1, register_id: 99 })).value, 10, 'point selection uses the selected semantic definition')
regs.pop()
regs[1].dataType = 'uint16'
rows = [{ ts: args.start, rawValue: 5, quality: 'good', batchId: 'same', slaveId: 1 }, { ts: args.start, rawValue: 10, quality: 'good', batchId: 'same', slaveId: 2 }, { ts: args.start, rawValue: 7, quality: 'good', batchId: 'legacy', slaveId: null }]
for (const selector of [{ slave_id: 2 }, { register_id: 2 }, { slave_id: 2, register_id: 2 }]) {
  const history = body(await run('query_history', { ...args, ...selector }))
  assert.equal(queriedSource, 2); assert.equal(history.slave_id, 2); assert.equal(history.register_id, 2)
  assert.deepEqual(history.points.map((p: any) => [p.slave_id, p.value, p.automatic_eligible]), [[2, 10, true], [null, null, false]])
}
regs[1].dataType = 'uint32'; rows = []
for (const tool of ['read_register', 'query_history']) {
  const before = [cacheReads, queryCalls]
  for (const selector of [{ slave_id: 3 }, { register_id: 999 }, { slave_id: 1, register_id: 2 }, { slave_id: null }, { register_id: '2' }, { address: 1, register_id: 2 }]) {
    const result = await run(tool, { ...args, ...selector }); assert.equal(result.isError, true)
    assert.ok(body(result).code.startsWith('REGISTER_'))
  }
  assert.deepEqual([cacheReads, queryCalls], before, 'invalid/conflicting selectors do not query cache/history or fall back')
  const schema = schemas.get(tool)
  assert.ok(schema.slave_id.safeParse(2).success); assert.ok(schema.register_id.safeParse(2).success)
  for (const invalid of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(schema.register_id.safeParse(invalid).success, false)
}
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
groups.push({ id: 2, objectId: 1, slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2 })
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
