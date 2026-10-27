import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerConfigBackup } from '../packages/api/src/config-backup.ts'

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
  const reg = cfg.listRegisters(id)[0]
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
