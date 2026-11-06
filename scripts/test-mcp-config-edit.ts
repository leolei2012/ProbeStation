import assert from 'node:assert/strict'
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConfigStore } from '../packages/config/src/index.ts'
import { apply } from '../packages/mcp/src/index.ts'

// Capture the real production registry and handlers. No socket, transport, model or instrument is opened.
const handlers = new Map<string, (args: any) => Promise<any>>(), schemas = new Map<string, any>(), configs = new Map<string, any>(), registrations = new Map<string, number>()
let events = 0, failNotify = false, failLog = false, failReconnect = false, failSync = false, reconnects = 0, syncs = 0, listens = 0, legacyCalls = 0, conditionalGroupWrites = 0
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++; if (failNotify) throw new Error('synthetic notify failure') })
const rawGroup = cfg.updateGroup.bind(cfg), rawDevice = cfg.updateObject.bind(cfg), log = cfg.log.bind(cfg), guardedGroup = cfg.updateGroupSettings.bind(cfg)
cfg.updateObject = (() => { legacyCalls++; throw new Error('legacy device update must not be used') }) as any
cfg.updateGroup = (() => { legacyCalls++; throw new Error('legacy group update must not be used') }) as any
cfg.updateGroupSettings = ((...args: Parameters<typeof guardedGroup>) => { conditionalGroupWrites++; return guardedGroup(...args) })
cfg.log = ((...args: Parameters<typeof log>) => { if (failLog) throw new Error('synthetic log failure'); return log(...args) })
const originalCreate = http.createServer, originalRegister = McpServer.prototype.registerTool
let factory: (() => McpServer) | undefined
try {
  http.createServer = (() => ({ listen() { listens++ } })) as any
  McpServer.prototype.registerTool = function (name: string, options: any, callback: any) { handlers.set(name, callback); schemas.set(name, options.inputSchema); configs.set(name, options); registrations.set(name, (registrations.get(name) ?? 0) + 1); return {} as any } as any
  apply({ config: cfg, store: {}, poller: { async reconnectDevice() { reconnects++; if (failReconnect) throw new Error('synthetic reconnect failure') } }, ota: {}, sink: {}, on() {}, get(name: string) { if (name === 'deviceSlaves') return { async sync() { syncs++; if (failSync) throw new Error('synthetic sync failure') } } }, provide(_name: string, value: any) { factory = value.createServer } } as any, { host: '127.0.0.1', port: 0 })
  const server = factory!(); await server.close()
} finally { http.createServer = originalCreate; McpServer.prototype.registerTool = originalRegister }
const body = (result: any) => JSON.parse(result.content[0].text)
const run = async (tool: string, args: any) => handlers.get(tool)!(args)
const device = cfg.createObject('synthetic MCP device', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic group', 3, 0, 2)
const first = cfg.createRegister(group.id, device.id, 'keep', 3, 0, 'uint16'), last = cfg.createRegister(group.id, device.id, 'delete only after review', 3, 1, 'uint16')
cfg.createRule(last.id, '>', 5, 'synthetic alarm')
const graph = () => JSON.stringify(cfg.exportBackup()).replace(/"createdAt":"[^"]+"/, '"createdAt":"fixed"')
try {
  assert.equal(listens, 1, 'only the intercepted listen method was called')
  for (const name of ['update_device', 'update_group', 'get_device_edit_snapshot', 'get_group_edit_snapshot', 'preview_group_update']) assert.equal(registrations.get(name), 1, 'production registry must use exactly one protected handler: ' + name)
  for (const name of ['get_device_edit_snapshot', 'get_group_edit_snapshot', 'preview_group_update']) { assert.equal(configs.get(name).annotations.readOnlyHint, true); assert.equal(configs.get(name).annotations.destructiveHint, false) }
  const unchanged = graph(), initialEvents = events, initialLogs = cfg.listLogs().length
  for (const [tool, args, next] of [
    ['update_group', { group_id: group.id, quantity: 1 }, 'get_group_edit_snapshot'],
    ['preview_group_update', { group_id: group.id, quantity: 1 }, 'get_group_edit_snapshot'],
    ['update_device', { device_id: device.id, ip: 'old-client.mock.invalid' }, 'get_device_edit_snapshot'],
  ] as const) {
    const result = await run(tool, args)
    assert.equal(result.isError, true); assert.equal(body(result).status, 428); assert.equal(body(result).code, 'CONFIG_PRECONDITION_REQUIRED'); assert.equal(body(result).next_tool, next)
    assert.equal(graph(), unchanged); assert.equal(events, initialEvents); assert.equal(cfg.listLogs().length, initialLogs)
  }
  assert.equal(conditionalGroupWrites, 0); assert.equal(reconnects, 0); assert.equal(syncs, 0)

  let snapshot = body(await run('get_group_edit_snapshot', { group_id: group.id })), before = graph(), count = events
  const preview = body(await run('preview_group_update', { group_id: group.id, expected_revision: snapshot.revision, quantity: 1 }))
  assert.equal(preview.expected_revision, snapshot.revision); assert.deepEqual(preview.plan.delete_register_ids, [last.id]); assert.equal(preview.plan.delete_rule_ids.length, 1)
  assert.equal(preview.deleted_points[0].alias, 'delete only after review'); assert.equal(preview.deleted_rules[0].message, 'synthetic alarm')
  assert.equal(graph(), before); assert.equal(events, count)
  for (const acknowledgment of [{}, { confirmed_delete_register_ids: [last.id] }, { confirmed_delete_register_ids: [first.id], confirmed_delete_rule_ids: preview.plan.delete_rule_ids }]) {
    const denied = await run('update_group', { group_id: group.id, expected_revision: snapshot.revision, quantity: 1, ...acknowledgment })
    assert.equal(denied.isError, true); assert.equal(body(denied).status, 400); assert.equal(graph(), before); assert.equal(events, count)
  }
  // The group row did not change, but new point/rule data must still invalidate the reviewed revision.
  const concurrent = cfg.createRegister(group.id, device.id, 'concurrent', 3, 8, 'uint16'); cfg.createRule(concurrent.id, '<', 1, 'concurrent alarm')
  before = graph(); count = events
  for (const name of ['preview_group_update', 'update_group']) {
    const conflict = await run(name, { group_id: group.id, expected_revision: snapshot.revision, quantity: 1, confirmed_delete_register_ids: preview.plan.delete_register_ids, confirmed_delete_rule_ids: preview.plan.delete_rule_ids })
    assert.equal(conflict.isError, true); assert.equal(body(conflict).code, 'CONFIG_CONFLICT'); assert.equal(body(conflict).status, 409)
    assert.equal(graph(), before); assert.equal(events, count)
  }
  snapshot = body(await run('get_group_edit_snapshot', { group_id: group.id }))
  const currentPreview = body(await run('preview_group_update', { group_id: group.id, expected_revision: snapshot.revision, quantity: 1 }))
  const shrunk = await run('update_group', { group_id: group.id, expected_revision: snapshot.revision, quantity: 1, confirmed_delete_register_ids: currentPreview.plan.delete_register_ids, confirmed_delete_rule_ids: currentPreview.plan.delete_rule_ids })
  assert.equal(shrunk.isError, undefined); assert.equal(body(shrunk).configuration_saved, true); assert.equal(body(shrunk).quantity, 1); assert.equal(body(shrunk).id, group.id, 'legacy group fields remain at the result root')
  assert.deepEqual(body(shrunk).deleted_register_ids, [last.id, concurrent.id]); assert.equal(body(shrunk).deleted_rule_ids.length, 2); assert.deepEqual(body(shrunk).warnings, [])
  assert.deepEqual(cfg.listRegisters(group.id).map(row => row.id), [first.id]); assert.equal(cfg.listRules().length, 0)
  before = graph(); count = events
  assert.equal(body(await run('update_group', { group_id: group.id, expected_revision: snapshot.revision, quantity: 1, confirmed_delete_register_ids: currentPreview.plan.delete_register_ids, confirmed_delete_rule_ids: currentPreview.plan.delete_rule_ids })).status, 409)
  assert.equal(graph(), before); assert.equal(events, count)
  snapshot = body(await run('get_group_edit_snapshot', { group_id: group.id }))
  const expanded = body(await run('update_group', { group_id: group.id, expected_revision: snapshot.revision, name: 'mapped group', slave_id: 7, function_code: 4, start_address: 10, quantity: 3, is_active: 0 }))
  assert.equal(expanded.configuration_saved, true); assert.equal(expanded.name, 'mapped group'); assert.equal(expanded.slaveId, 7); assert.equal(expanded.functionCode, 4); assert.equal(expanded.startAddress, 10); assert.equal(expanded.isActive, 0)
  assert.equal(expanded.added_register_ids.length, 2); assert.equal(cfg.getRegister(first.id)!.startAddress, 0)
  assert.ok(cfg.listRegisters(group.id).filter(row => row.id !== first.id).every(row => row.functionCode === 4 && row.dataType === 'int16'))

  const expected = body(await run('get_device_edit_snapshot', { device_id: device.id })).expected
  assert.equal(Object.hasOwn(expected, 'isActive'), false); assert.equal(Object.hasOwn(expected, 'dataRetainSeconds'), false)
  rawDevice(device.id, { ip: 'concurrent-device.mock.invalid' }); before = graph(); count = events
  const conflictDevice = await run('update_device', { device_id: device.id, expected, name: 'stale rename' })
  assert.equal(conflictDevice.isError, true); assert.equal(body(conflictDevice).status, 409); assert.equal(graph(), before); assert.equal(events, count); assert.equal(reconnects, 0); assert.equal(syncs, 0)
  let freshExpected = body(await run('get_device_edit_snapshot', { device_id: device.id })).expected
  rawDevice(device.id, { isActive: 0, dataRetainSeconds: 1234 })
  const changedDevice = body(await run('update_device', { device_id: device.id, expected: freshExpected, name: 'mapped device', poll_interval_ms: 25, timeout_ms: 2000, port: 1502, serial_path: 'SYNTHETIC_ONLY', baud_rate: 19200, parity: 'odd', stop_bits: 2, data_bits: 7, flow_control: 'rtscts', slave_id: 9 }))
  assert.equal(changedDevice.configuration_saved, true); assert.equal(changedDevice.id, device.id); assert.equal(changedDevice.pollIntervalMs, 25); assert.equal(changedDevice.timeoutMs, 2000); assert.equal(changedDevice.baudRate, 19200); assert.equal(changedDevice.dataBits, 7)
  assert.equal(changedDevice.isActive, 0); assert.equal(changedDevice.dataRetainSeconds, 1234); assert.equal(reconnects, 1); assert.equal(syncs, 1); assert.deepEqual(changedDevice.warnings, [])

  // Existing MCP master/slave application sequence is retained; every hook here is a mock.
  freshExpected = body(await run('get_device_edit_snapshot', { device_id: device.id })).expected
  const slave = body(await run('update_device', { device_id: device.id, expected: freshExpected, mode: 'slave', ip: '127.0.0.1', data_bits: 8 }))
  assert.equal(slave.configuration_saved, true); assert.equal(reconnects, 1); assert.equal(syncs, 2, 'slave transition keeps this MCP entrypoint\'s previous reconnect/sync policy')
  rawDevice(device.id, { mode: 'master' })
  failNotify = true; failLog = true; failReconnect = true; failSync = true
  const warned = await run('update_device', { device_id: device.id, expected: body(await run('get_device_edit_snapshot', { device_id: device.id })).expected, name: 'committed with warnings' })
  failNotify = false; failLog = false; failReconnect = false; failSync = false
  assert.equal(warned.isError, undefined); assert.equal(body(warned).configuration_saved, true); assert.equal(body(warned).warnings.length, 4); assert.equal(cfg.getObject(device.id)!.name, 'committed with warnings')
  failNotify = true; failLog = true
  const groupWarned = await run('update_group', { group_id: group.id, expected_revision: body(await run('get_group_edit_snapshot', { group_id: group.id })).revision, name: 'committed group warning' })
  failNotify = false; failLog = false
  assert.equal(groupWarned.isError, undefined); assert.equal(body(groupWarned).configuration_saved, true); assert.equal(body(groupWarned).warnings.length, 2)

  for (const args of [{ group_id: group.id, expected_revision: 'invalid', quantity: 1 }, { group_id: group.id, expected_revision: body(await run('get_group_edit_snapshot', { group_id: group.id })).revision, quantity: 0 }]) {
    before = graph(); count = events
    const result = await run('update_group', args); assert.equal(result.isError, true); assert.equal(body(result).status, 400); assert.equal(graph(), before); assert.equal(events, count)
  }
  before = graph(); count = events; const runtimeBefore = [reconnects, syncs]
  const invalidDevice = await run('update_device', { device_id: device.id, expected: {}, name: 'bad' })
  assert.equal(body(invalidDevice).status, 400); assert.equal(graph(), before); assert.equal(events, count); assert.deepEqual([reconnects, syncs], runtimeBefore)
  const update = cfg.updateGroupSettings
  cfg.updateGroupSettings = (() => { throw new Error('synthetic internal detail must not leak') }) as any
  try { const unknown = await run('update_group', { group_id: group.id, expected_revision: body(await run('get_group_edit_snapshot', { group_id: group.id })).revision, name: 'unknown outcome' }); assert.equal(unknown.isError, true); assert.equal(body(unknown).code, 'CONFIG_SAVE_UNCERTAIN'); assert.match(body(unknown).error, /待核实/); assert.doesNotMatch(unknown.content[0].text, /synthetic internal detail/) }
  finally { cfg.updateGroupSettings = update }
  for (const name of ['update_device', 'get_device_edit_snapshot']) for (const bad of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(schemas.get(name).device_id.safeParse(bad).success, false)
  for (const name of ['update_group', 'get_group_edit_snapshot', 'preview_group_update']) assert.equal(schemas.get(name).group_id.safeParse(group.id).success, true)
  assert.equal(schemas.get('update_group').expected_revision.isOptional(), true, 'old argument shape reaches an explicit migration error, never an unsafe implicit write')
  assert.equal(schemas.get('update_group').confirmed_delete_register_ids.safeParse([1, '2']).success, false)
  assert.equal(schemas.get('update_device').expected.safeParse(null).success, false)
  assert.equal(legacyCalls, 0, 'protected MCP callbacks never invoke legacy config setters')
  // Exercise the unpatched production SDK registry, JSON schemas and protocol over linked memory transports.
  const liveServer = factory!(), client = new Client({ name: 'synthetic-config-test', version: '1' }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await liveServer.connect(serverTransport); await client.connect(clientTransport)
    const listed = await client.listTools()
    assert.equal(listed.tools.filter(tool => tool.name === 'update_group').length, 1)
    const missing = await client.callTool({ name: 'update_group', arguments: { group_id: group.id, quantity: 1 } })
    assert.equal(missing.isError, true); assert.equal(body(missing).code, 'CONFIG_PRECONDITION_REQUIRED')
    const protocolSnapshot = body(await client.callTool({ name: 'get_group_edit_snapshot', arguments: { group_id: group.id } }))
    const protocolPreview = body(await client.callTool({ name: 'preview_group_update', arguments: { group_id: group.id, expected_revision: protocolSnapshot.revision, quantity: 1 } }))
    const protocolSaved = await client.callTool({ name: 'update_group', arguments: { group_id: group.id, expected_revision: protocolSnapshot.revision, quantity: 1, confirmed_delete_register_ids: protocolPreview.plan.delete_register_ids, confirmed_delete_rule_ids: protocolPreview.plan.delete_rule_ids } })
    assert.equal(protocolSaved.isError, undefined); assert.equal(body(protocolSaved).configuration_saved, true)
    const protocolDevice = body(await client.callTool({ name: 'get_device_edit_snapshot', arguments: { device_id: device.id } }))
    assert.equal(body(await client.callTool({ name: 'update_device', arguments: { device_id: device.id, expected: protocolDevice.expected, name: 'protocol verified device' } })).configuration_saved, true)
    const invalidSchema = await client.callTool({ name: 'update_group', arguments: { group_id: group.id, expected_revision: 'bad', confirmed_delete_register_ids: ['wrong type'] } })
    assert.equal(invalidSchema.isError, true)
  } finally { await client.close(); await liveServer.close() }
  assert.equal(legacyCalls, 0); assert.equal(listens, 1, 'in-memory MCP adds no real listeners or sockets')
  const deletedSnapshot = body(await run('get_group_edit_snapshot', { group_id: group.id })); cfg.deleteGroup(group.id)
  assert.equal(body(await run('update_group', { group_id: group.id, expected_revision: deletedSnapshot.revision, name: 'deleted' })).status, 404)
  cfg.deleteObject(device.id)
  assert.equal(body(await run('get_device_edit_snapshot', { device_id: device.id })).status, 404)
  assert.equal(body(await run('get_group_edit_snapshot', { group_id: group.id })).status, 404)
  console.log('MCP CONFIG EDIT OK: real production registry, explicit preconditions/no fallback, coherent read/preview, exact deletion acknowledgment, stale points/rules/source rejection, mapping and root-field compatibility, runtime/log/notification warnings and safe schema/errors; memory-only and intercepted listener/mock runtime, no hardware or network')
} finally { (cfg as any).db.close() }
