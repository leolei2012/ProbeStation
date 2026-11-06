import assert from 'node:assert/strict'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { apply } from '../packages/mcp/src/index.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'

// Register production read handlers without opening any socket or loading real services.
const handlers = new Map<string, (args: any) => Promise<any>>()
let factory: (() => McpServer) | undefined, listens = 0, ambiguous = true
const groups = [1, 2].map(id => ({ id, slaveId: id, functionCode: 3, startAddress: 0, quantity: 2 }))
const regs = groups.map(g => ({ id: g.id, groupId: g.id, startAddress: 0, functionCode: 3, dataType: 'uint32' }))
let latest: Record<string, any> = {}
let rows: any[] = []
let queriedSource: number | undefined
const cfg = { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => groups, listRegistersByObject: () => ambiguous ? regs : [regs[0]] }
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
  McpServer.prototype.registerTool = function (name: string, _config: any, callback: any) { handlers.set(name, callback); return {} as any } as any
  const ctx = { config: cfg, store, poller: {}, on: () => {}, provide: (_name: string, service: any) => { factory = service.createServer } }
  apply(ctx as any, { host: '127.0.0.1', port: 0 })
  const server = factory!(); await server.close()
} finally { http.createServer = originalCreate; McpServer.prototype.registerTool = originalRegister }
assert.equal(listens, 1, 'listen was intercepted, no server or transport was actually started')
const args = { device_id: 1, area: 'holding-register', address: 0, start: '2026-11-06T00:00:00Z', end: '2026-11-06T00:01:00Z' }
const run = async (name: string) => handlers.get(name)!(args)
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
console.log('MCP SOURCE OK: production read-handler registry mocked without listeners; separate snapshots, ambiguous address refusal, missing/mixed cache, source-filtered raw history and NULL compatibility')
