import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerConfigBackup } from '../packages/api/src/config-backup.ts'
import type { ConfigBackup } from '../packages/config/src/backup.ts'
import { parseConfigBackup } from '../packages/config/src/backup.ts'
import { registerWidth } from '../packages/core/src/codec.ts'

async function quantityMetadataRoundTrip() {
  const source = new ConfigStore({ dbPath: ':memory:' }), changes: string[] = []
  const target = new ConfigStore({ dbPath: ':memory:' }, scope => changes.push(scope))
  const api = Fastify(); registerConfigBackup(api, target)
  try {
    const device = source.createObject('Quantity metadata fixture', '', 1502)
    const group = source.createGroup(device.id, 'Two-word read', 3, 0, 2)
    const point = source.createRegister(group.id, device.id, 'Wide', 3, 0, 'uint32')
    // Emulate an existing record without relying on the creation API being fixed first.
    ;(source as any).db.prepare('UPDATE registers SET quantity = 2 WHERE id = ?').run(point.id)
    const backup = JSON.parse(JSON.stringify(source.exportBackup())) as ConfigBackup
    for (const quantity of [2, 4, 3, 65537, Number.MAX_SAFE_INTEGER]) {
      const next = structuredClone(backup); next.registers[0].quantity = quantity
      const restored = target.restoreBackup(next)
      const actual = target.listRegistersByObject(restored.deviceIds[0])[0]
      assert.equal(actual.quantity, quantity, 'restore must preserve explicit independent quantity metadata')
      assert.equal(registerWidth(actual.dataType), 2, 'metadata does not change dtype decoding width')
      assert.equal(target.listGroups(restored.deviceIds[0])[0].quantity, 2, 'metadata does not change the group read length')
      assert.equal(target.exportBackup().registers.find(r => r.id === actual.id)!.quantity, quantity, 're-export retains exact metadata, including values above protocol read limits')
    }
    const legacy: any = structuredClone(backup); delete legacy.registers[0].quantity
    Object.freeze(legacy.registers[0]); Object.freeze(legacy.registers); Object.freeze(legacy)
    assert.equal(parseConfigBackup(legacy).registers[0].quantity, 1, 'missing legacy field defaults to the original database default, not dtype width')
    const imported = target.restoreBackup(legacy)
    assert.equal(target.listRegistersByObject(imported.deviceIds[0])[0].quantity, 1)
    assert.equal(Object.hasOwn(legacy.registers[0], 'quantity'), false, 'parsing must not mutate the supplied legacy backup')
    const snapshot = () => { const { createdAt, ...saved } = target.exportBackup(); return JSON.parse(JSON.stringify(saved)) }
    const before = snapshot(), stats = target.metadataStats()
    changes.length = 0
    const invalid = [0, -1, 1.5, '2', '', null, true, false, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 2n, {}]
    for (const quantity of invalid) {
      const bad: any = structuredClone(backup)
      bad.registers.push({ ...bad.registers[0], id: 2, startAddress: 1, dataType: 'uint16', quantity })
      assert.throws(() => target.previewBackup(bad), /quantity|数量/, 'preview must reject invalid explicit quantity')
      assert.throws(() => target.restoreBackup(bad), /quantity|数量/, 'restore must reject invalid explicit quantity')
      assert.deepEqual(snapshot(), before, 'invalid metadata must leave all target configuration intact')
      assert.deepEqual(target.metadataStats(), stats)
      assert.deepEqual(changes, [], 'failed validation emits no configuration events')
    }
    const headers = { 'x-probestation-config': '1' }
    const bad = structuredClone(backup); (bad.registers[0] as any).quantity = '2'
    assert.equal((await api.inject({ method: 'POST', url: '/api/config/backup/restore', headers, payload: bad })).statusCode, 400)
    assert.deepEqual(snapshot(), before)
    const direct = source.createRegister(group.id, device.id, 'Metadata count', 3, 1, 'uint16', { quantity: 65537 } as any)
    assert.equal(direct.quantity, 65537)
    const sourceCount = source.listRegistersByObject(device.id).length
    assert.throws(() => source.createRegister(group.id, device.id, 'Invalid metadata', 3, 1, 'uint16', { quantity: null } as any), /quantity|数量/)
    assert.equal(source.listRegistersByObject(device.id).length, sourceCount)
    console.log('QUANTITY METADATA OK: exact safe integers, legacy default 1, invalid input isolation and unchanged dtype/read length')
  } finally { await api.close(); (source as any).db.close(); (target as any).db.close() }
}

await quantityMetadataRoundTrip()

/** Compare the whole configuration graph while allowing remapped IDs and paused imports. */
function canonicalBackup(b: ConfigBackup, selected = new Set(b.devices.map(d => d.id))) {
  const fields = (value: object, excluded: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)))
  const sorted = <T,>(values: T[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return sorted(b.devices.filter(d => selected.has(d.id)).map(d => ({
    device: { ...fields(d, ['id', 'isActive']), isActive: 0 },
    groups: sorted(b.groups.filter(g => g.objectId === d.id).map(g => ({
      group: fields(g, ['id', 'objectId']),
      registers: sorted(b.registers.filter(r => r.groupId === g.id).map(r => ({
        register: fields(r, ['id', 'groupId', 'objectId']),
        rules: sorted(b.rules.filter(rule => rule.registerId === r.id).map(rule => fields(rule, ['id', 'registerId']))),
      }))),
    }))),
  })))
}

function fullGraphRoundTrip() {
  const source = new ConfigStore({ dbPath: ':memory:' }), target = new ConfigStore({ dbPath: ':memory:' })
  try {
    const a = source.createObject('Alpha', '', 1502, 'master', { transport: 'rtu', serialPath: 'MOCK-COM-A', baudRate: 19200, parity: 'odd', stopBits: 2, dataBits: 7, flowControl: 'rtscts', slaveId: 7, timeoutMs: 1250 })
    const b = source.createObject('Beta', '', 1503, 'slave', { transport: 'rtu', serialPath: 'MOCK-COM-B', baudRate: 115200, parity: 'none', stopBits: 2, dataBits: 8, flowControl: 'xonxoff', slaveId: 17, pollIntervalMs: 250, timeoutMs: 900, dataRetainSeconds: 0 })
    const emptyDevice = source.createObject('Empty device', '', 1504)
    // Intentionally interleave devices and groups so their IDs do not line up.
    const bInput = source.createGroup(b.id, 'B input', 4, 10, 2, 'read', 17)
    const aHolding = source.createGroup(a.id, 'A holding', 3, 0, 4, 'readwrite', 19)
    const aInput = source.createGroup(a.id, 'A input', 4, 0, 1)
    const emptyGroup = source.createGroup(a.id, 'Empty group', 3, 50, 1)
    const bCoil = source.createGroup(b.id, 'B coil', 1, 0, 1)
    const first = source.createRegister(aHolding.id, a.id, 'Temperature', 3, 0, 'uint32', { factor: .1, offset: -5, unit: '℃', decimalPlaces: 2 })
    source.createRegister(aHolding.id, a.id, null, 3, 2, 'int16', { enumJson: '{"0":"关闭","1":"开启"}' })
    source.createRegister(aInput.id, a.id, 'Input', 4, 0, 'uint16')
    const last = source.createRegister(bInput.id, b.id, 'Pressure', 4, 10, 'float32-LE', { factor: 2, unit: 'kPa' })
    source.createRegister(bCoil.id, b.id, 'Switch', 1, 0, 'uint16')
    source.createRule(first.id, '>=', 300, 'High temperature')
    source.createRule(last.id, '<', 1, null)
    source.updateGroup(emptyGroup.id, { isActive: 0 })
    source.updateObject(a.id, { pollIntervalMs: 500, dataRetainSeconds: 86400 })
    const backup = JSON.parse(JSON.stringify(source.exportBackup())) as ConfigBackup
    const expected = source.listObjects().flatMap(d => source.listRegistersByObject(d.id)).map(r => ({ ...r }))
    assert.equal(backup.registers.length, 5, 'backup must include every point from all device groups')
    assert.deepEqual([...backup.registers].sort((a, b) => a.id - b.id), [...expected].sort((a, b) => a.id - b.id), 'all point fields and ownership must survive export')
    assert.equal(new Set(backup.registers.map(r => r.id)).size, 5, 'export must not duplicate points')
    assert.equal(backup.devices.length, 3)
    assert.equal(backup.groups.length, 5)
    assert.equal(backup.groups.filter(g => g.id === emptyGroup.id).length, 1)
    assert.equal(backup.registers.filter(r => r.groupId === emptyGroup.id).length, 0)
    assert.equal(backup.groups.filter(g => g.objectId === emptyDevice.id).length, 0)
    assert.deepEqual(source.previewBackup(backup).counts, { devices: 3, groups: 5, registers: 5, rules: 2 })
    const existing = target.createObject('Existing fixture', '', 1505)
    const existingGroup = target.createGroup(existing.id, 'Existing group', 3, 100, 1)
    const existingPoint = target.createRegister(existingGroup.id, existing.id, 'Existing point', 3, 100, 'uint16')
    target.createRule(existingPoint.id, '>', 100, 'Existing rule')
    const existingGraph = canonicalBackup(target.exportBackup())
    const result = target.restoreBackup(backup)
    assert.deepEqual({ devices: result.devices, groups: result.groups, registers: result.registers, rules: result.rules }, { devices: 3, groups: 5, registers: 5, rules: 2 })
    assert.equal(target.getObject(existing.id)!.isActive, 1, 'restoring must retain existing device state')
    assert.deepEqual(canonicalBackup(target.exportBackup(), new Set([existing.id])), existingGraph, 'existing device, groups, points and alarms must remain unchanged')
    for (const id of result.deviceIds) assert.equal(target.getObject(id)!.isActive, 0)
    assert.deepEqual(canonicalBackup(target.exportBackup(), new Set(result.deviceIds)), canonicalBackup(backup), 'export -> restore -> export retains all groups, points, semantics and rules')
    console.log('CONFIG BACKUP GRAPH OK: 3 devices, 5 groups, 5 points, 2 rules; RTU parameters, group modes/Slave IDs, empty groups/devices and full JSON restore roundtrip')
  } finally { (source as any).db.close(); (target as any).db.close() }
}

fullGraphRoundTrip()

const events: string[] = []
const cfg = new ConfigStore({ dbPath: ':memory:' }, scope => events.push(scope))
const app = Fastify()
registerConfigBackup(app, cfg)
try {
  const d = cfg.createObject('Test', '127.0.0.1', 1502, 'slave')
  const g = cfg.createGroup(d.id, 'Holding', 3, 0, 2)
  const r = cfg.createRegister(g.id, d.id, 'Temperature', 3, 0, 'uint32', { factor: .1, offset: -5, unit: '℃', enumJson: '{"0":"关闭"}', decimalPlaces: 1 })
  cfg.createRule(r.id, '>=', 300, '温度高')
  const backup = cfg.exportBackup(), before = cfg.metadataStats()
  const headers = { 'x-probestation-config': '1' }
  events.length = 0
  const preview = await app.inject({ method: 'POST', url: '/api/config/backup/preview', headers, payload: backup })
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal(preview.json().devices[0].sameName, true)
  assert.deepEqual(cfg.metadataStats(), before, 'preview cannot mutate live configuration')
  assert.deepEqual(events, [])
  const invalid = structuredClone(backup); invalid.rules[0].registerId = 999
  assert.equal((await app.inject({ method: 'POST', url: '/api/config/backup/restore', headers, payload: invalid })).statusCode, 400)
  const lateFailure = structuredClone(backup); lateFailure.rules[0].message = 'x'.repeat(201)
  assert.throws(() => cfg.restoreBackup(lateFailure))
  assert.deepEqual(cfg.metadataStats(), before, 'a failure after inserts rolls back the entire restore')
  assert.deepEqual(events, [], 'rollback emits no configuration events')
  assert.equal((await app.inject({ method: 'POST', url: '/api/config/backup/restore', payload: backup })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/config/backup/restore', headers: { ...headers, origin: 'https://other.example' }, payload: backup })).statusCode, 403)
  const restored = await app.inject({ method: 'POST', url: '/api/config/backup/restore', headers, payload: backup })
  assert.equal(restored.statusCode, 200, restored.body)
  const id = restored.json().deviceIds[0]
  assert.notEqual(id, d.id)
  assert.equal(cfg.getObject(id)!.isActive, 0)
  assert.equal(cfg.getObject(d.id)!.isActive, 1)
  const reg = cfg.listRegistersByObject(id)[0]
  for (const field of ['alias', 'dataType', 'unit', 'factor', 'offset', 'enumJson', 'decimalPlaces'] as const) assert.equal(reg[field], r[field])
  assert(cfg.listRules().some(rule => rule.registerId === reg.id && rule.threshold === 300))
  assert.deepEqual(events, ['backup'])
  const exported = await app.inject('/api/config/backup')
  assert.equal(exported.statusCode, 200)
  assert.equal(exported.json().devices.length, 2)
  assert(!exported.body.includes('apiKey'))
  for (const tamper of [(b: any) => b.version = 2, (b: any) => b.devices.push(b.devices[0]), (b: any) => b.registers[0].factor = 'invalid', (b: any) => b.registers[0].objectId = 999]) {
    const b = structuredClone(backup); tamper(b); assert.throws(() => cfg.previewBackup(b))
  }
  console.log('CONFIG BACKUP OK: preview, remapped IDs, paused devices, semantics/alarms, atomic rollback and origin guard')
} finally { await app.close(); (cfg as any).db.close() }
