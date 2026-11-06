import assert from 'node:assert/strict'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerPointsImport } from '../packages/api/src/points-import.ts'
import { guessField, smartParseCsv, smartParseTable } from '../packages/core/src/points.ts'
import { normalizeSemanticPoint } from '../packages/core/src/semantic-import.ts'

// Memory-only config and Fastify.inject: no bootstrap, sockets, drivers or real data.
let observe = false
const events: string[] = []
const cfg = new ConfigStore({ dbPath: ':memory:' }, scope => { if (observe) events.push(scope) })
const app = Fastify(); registerPointsImport(app, cfg)
const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules() })
try {
  const d = cfg.createObject('mock semantic import', 'mock.invalid', 502)
  const groups = [1, 2].map(source => cfg.createGroup(d.id, 'source ' + source, 3, 0, 4, 'read', source))
  const regs = groups.map(g => cfg.createRegister(g.id, d.id, 'source ' + g.slaveId, 3, 0, 'uint32', { quantity: 8, unit: 'A', factor: 2, offset: 3, enumJson: '{"1":"one"}' }))
  cfg.createRule(regs[0].id, '>', 10, 'keep rule')
  const other = cfg.createObject('other mock', 'mock.invalid', 502), og = cfg.createGroup(other.id, 'other', 3, 0, 4, 'read', 2)
  const otherReg = cfg.createRegister(og.id, other.id, 'untouched', 3, 0, 'uint32')
  const point = (extra: any = {}) => ({ functionCode: 3, address: 0, alias: 'updated', ...extra })
  observe = true
  let before = snapshot(), count = events.length
  // Baseline reproduction: this assertion failed with updated=1 before the fix.
  const ambiguous = cfg.importPoints(d.id, [point()])
  assert.equal(ambiguous.updated, 0, 'must not choose the first slave'); assert.equal(ambiguous.skipped, 1)
  assert.equal(snapshot(), before); assert.equal(events.length, count)
  assert.equal(ambiguous.details[0].code, 'REGISTER_AMBIGUOUS')
  assert.deepEqual((ambiguous.details[0].candidates as any[]).map(c => [c.register_id, c.slave_id]), regs.map((r, i) => [r.id, i + 1]))
  assert.equal(cfg.importPoints(d.id, [point({ slaveId: 2 })]).updated, 1)
  assert.deepEqual({ ...cfg.getRegister(regs[1].id) }, { ...regs[1], alias: 'updated' }, 'omitted metadata must remain unchanged')
  assert.deepEqual(cfg.getRegister(regs[0].id), regs[0]); assert.deepEqual(events, ['point-import'])
  assert.equal(cfg.importPoints(d.id, [point({ registerId: regs[0].id })]).updated, 1)
  assert.equal(cfg.importPoints(d.id, [point({ registerId: regs[1].id, slaveId: 2 })]).updated, 1)
  const invalidSelectors = [{ slaveId: 3 }, { registerId: otherReg.id }, { registerId: 999 }, { registerId: regs[1].id, slaveId: 1 }, { address: 1, registerId: regs[1].id }, { functionCode: 4, registerId: regs[1].id }, { functionCode: 6 }, ...['2', null, -1, 256, 1.5].map(slaveId => ({ slaveId })), ...['2', null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(registerId => ({ registerId }))]
  for (const invalid of invalidSelectors) {
    before = snapshot(); count = events.length
    const result = cfg.importPoints(d.id, [point(invalid)])
    assert.equal(result.updated, 0, JSON.stringify(invalid)); assert.equal(result.skipped, 1)
    assert.equal(snapshot(), before); assert.equal(events.length, count)
  }
  const duplicate = cfg.createRegister(groups[0].id, d.id, 'alternative', 3, 0, 'uint16')
  assert.equal(cfg.importPoints(d.id, [point({ slaveId: 1 })]).updated, 0)
  assert.equal(cfg.importPoints(d.id, [point({ registerId: duplicate.id, slaveId: 1 })]).updated, 1); cfg.deleteRegister(duplicate.id)
  const selector = { functionCode: 3, address: 0, registerId: regs[0].id }
  for (const invalid of [{ dataType: 'nonsense' }, { dataType: null }, { unit: 1 }, { alias: 1 }, { factor: '2' }, { factor: Infinity }, { offset: NaN }, { enumMap: [] }, { enumMap: { a: 1 } }]) {
    before = snapshot(); assert.equal(cfg.importPoints(d.id, [{ ...selector, ...invalid } as any]).updated, 0); assert.equal(snapshot(), before)
  }
  cfg.importPoints(d.id, [{ ...selector, unit: null, enumMap: null, factor: 0, offset: 0, alias: '' }])
  assert.deepEqual([cfg.getRegister(regs[0].id)!.unit, cfg.getRegister(regs[0].id)!.enumJson, cfg.getRegister(regs[0].id)!.factor, cfg.getRegister(regs[0].id)!.alias], [null, null, 0, ''])
  for (const dataType of ['uint64-LE', 'float64', 'q31_LE', 'hex32']) assert.equal(cfg.importPoints(d.id, [{ ...selector, dataType }]).updated, 1)
  const eg = cfg.createGroup(d.id, 'edge', 4, 65535, 1, 'read', 1), edge = cfg.createRegister(eg.id, d.id, 'edge', 4, 65535, 'uint16')
  for (const dataType of ['uint32', 'float64-LE', 'q31']) {
    before = snapshot(); const result = cfg.importPoints(d.id, [{ functionCode: 4, address: 65535, registerId: edge.id, dataType }])
    assert.equal(result.updated, 0); assert.equal(result.details[0].code, 'SEMANTIC_WIDTH_OUTSIDE_GROUP'); assert.equal(snapshot(), before)
  }
  assert.equal(cfg.importPoints(d.id, [{ functionCode: 4, address: 65535, dataType: 'uint16-LE' }]).updated, 1)
  count = events.length; assert.equal(cfg.importPoints(d.id, [{ ...selector, alias: null }]).skipped, 1); assert.equal(events.length, count)
  const mixed = cfg.importPoints(d.id, [point(), { ...selector, alias: 'valid row' }]); assert.deepEqual([mixed.updated, mixed.skipped, mixed.errors.length], [1, 1, 1])
  cfg.importPoints(d.id, [{ ...selector, alias: 'first' }, { ...selector, alias: 'last' }]); assert.equal(cfg.getRegister(regs[0].id)!.alias, 'last')
  assert.equal(cfg.getRegister(regs[0].id)!.quantity, 8)
  const update = cfg.updateRegister.bind(cfg), db = (cfg as any).db, exec = db.exec.bind(db)
  for (const failure of ['write', 'commit']) {
    before = snapshot(); count = events.length; let writes = 0
    try {
      if (failure === 'write') cfg.updateRegister = ((...args: any[]) => { if (++writes === 2) throw new Error('injected write failure'); return (update as any)(...args) }) as any
      else db.exec = (sql: string) => { if (sql === 'COMMIT') throw new Error('injected commit failure'); return exec(sql) }
      assert.throws(() => cfg.importPoints(d.id, regs.map(r => point({ registerId: r.id, alias: failure }))), /injected/)
    } finally { cfg.updateRegister = update; db.exec = exec }
    assert.equal(snapshot(), before); assert.equal(events.length, count)
    cfg.importPoints(d.id, regs.map(r => point({ registerId: r.id, alias: 'retry' }))); assert.equal(events.length, count + 1)
  }
  const post = (payload: any, id = d.id) => app.inject({ method: 'POST', url: `/api/monitor_objects/${id}/points/import`, payload })
  for (const payload of [[{ area: 'holding-register', address: 0, slave_id: 2, alias: 'JSON' }], { csv: '从站地址,寄存器地址,别名\n2,0,CSV' }]) {
    const old = cfg.getRegister(regs[1].id)!, response = await post(payload)
    assert.equal(response.statusCode, 200); assert.equal(response.json().updated, 1)
    const current = cfg.getRegister(regs[1].id)!; assert.deepEqual({ ...current }, { ...old, alias: current.alias })
  }
  const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('points')
  sheet.addRow(['Register ID', 'Address', 'Alias']); sheet.addRow([regs[1].id, 0, 'XLSX'])
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'), old = cfg.getRegister(regs[1].id)!
  assert.equal((await post({ xlsx })).json().updated, 1); assert.deepEqual({ ...cfg.getRegister(regs[1].id) }, { ...old, alias: 'XLSX' })
  assert.equal((await post([{ area: 'holding-register', address: 0, alias: 'ambiguous' }])).json().details[0].code, 'REGISTER_AMBIGUOUS')
  for (const payload of [42, {}, [null], [{ area: 'holding-register', address: 0, slave_id: 1, slaveId: 2 }], { xlsx: 'invalid' }]) {
    before = snapshot(); const response = await post(payload); assert.equal(response.statusCode, 400); assert.equal(snapshot(), before)
  }
  assert.equal((await post([], 99999)).statusCode, 404)
  const importPoints = cfg.importPoints.bind(cfg)
  before = snapshot()
  try {
    cfg.importPoints = () => { throw new Error('injected internal detail') }
    const failed = await post([]); assert.equal(failed.statusCode, 500)
    assert.ok(!failed.body.includes('injected internal detail')); assert.match(failed.json().error, /勿自动重复/)
  } finally { cfg.importPoints = importPoints }
  assert.equal(snapshot(), before)
  assert.equal((await post([{ area: 'holding-register', address: 0, slave_id: 2, unit: null, enum: null }])).json().updated, 1)
  assert.equal(cfg.getRegister(regs[1].id)!.unit, null); assert.equal(cfg.getRegister(regs[1].id)!.enumJson, null)
  assert.equal(cfg.getRegister(otherReg.id)!.alias, 'untouched')
  const slave = cfg.createObject('local mock only', '127.0.0.1', 502, 'slave', { slaveId: 7 })
  const sg = cfg.createGroup(slave.id, 'configured group source differs', 3, 0, 2, 'read', 2)
  const sr = cfg.createRegister(sg.id, slave.id, 'local', 3, 0, 'uint32')
  assert.equal(cfg.importPoints(slave.id, [point({ slaveId: 2 })]).updated, 0, 'slave mode uses device source, not the unused group source')
  assert.equal(cfg.importPoints(slave.id, [point({ slaveId: 7 })]).updated, 1); assert.equal(cfg.getRegister(sr.id)!.alias, 'updated')
} finally { await app.close(); (cfg as any).db.close() }

for (const header of ['slave_id', 'Slave Address', 'unit-id', '从站地址']) assert.equal(guessField(header), 'slaveId')
for (const header of ['register_id', 'Point ID', '点位ID']) assert.equal(guessField(header), 'registerId')
assert.equal(guessField('ID'), 'ignore'); assert.equal(guessField('寄存器地址'), 'address')
const csv = '从站ID,寄存器地址,别名\n2,0,new alias'
assert.deepEqual(smartParseCsv(csv, { partial: true }).points[0], { area: 'holding-register', address: 0, slaveId: 2, alias: 'new alias' })
const full = smartParseCsv(csv).points[0]; assert.equal(full.dataType, 'int16'); assert.equal(full.unit, null); assert.equal(full.factor, 0); assert.equal(full.enumMap, null)
const blank = smartParseTable([['Address', 'Unit', 'Enum', 'Factor', 'DataType'], ['0', '', '', '', '']], { partial: true }).points[0]
assert.equal(blank.unit, null); assert.equal(blank.enumMap, null); assert.equal(blank.factor, 0); assert.equal(blank.dataType, 'int16')
for (const raw of ['no', '2x', '-1', '256', '1.5']) assert.equal(smartParseCsv(`slave_id,address,alias\n${raw},0,unsafe`, { partial: true }).points.length, 0)
for (const header of ['slave_id,Slave Address,address', 'register_id,Point ID,address', 'Address,寄存器地址', 'Area,FC,address']) {
  const result = smartParseCsv(header + '\n1,2,0', { partial: true }); assert.equal(result.points.length, 0); assert.ok(result.report.errors.length)
}
assert.equal(smartParseCsv('Address,Area,Alias\n0,unrecognized,new', { partial: true }).points.length, 0)
assert.equal(smartParseCsv('Address,DataType\n0,unrecognized', { partial: true }).points.length, 0)
assert.equal(smartParseCsv('Address,DataType\n0,uint64_LE', { partial: true }).points[0].dataType, 'uint64-LE')
assert.ok(Number.isNaN(smartParseCsv('Address,Factor\n0,oops', { partial: true }).points[0].factor))
assert.equal(normalizeSemanticPoint({ area: 'holding-register', address: 0 }).dataType, undefined)
assert.throws(() => normalizeSemanticPoint({ area: 'holding-register', address: 0, data_type: 'uint16', dataType: 'uint32' }), /冲突/)
let failNotification = false
const notifyCfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (failNotification) throw new Error('injected notification failure') })
try {
  const d = notifyCfg.createObject('mock callback', 'mock.invalid', 502), g = notifyCfg.createGroup(d.id, 'g', 3, 0, 1)
  const r = notifyCfg.createRegister(g.id, d.id, 'old', 3, 0)
  failNotification = true
  const result = notifyCfg.importPoints(d.id, [{ functionCode: 3, address: 0, alias: 'committed' }])
  assert.equal(notifyCfg.getRegister(r.id)!.alias, 'committed'); assert.equal(result.updated, 1); assert.match(result.warnings[0], /已提交/)
} finally { (notifyCfg as any).db.close() }
console.log('SEMANTIC IMPORT OK: exact source/point selection, omission/null/blank behavior, width/metadata validation, rollback/retry, production JSON/CSV/XLSX route; memory only, no listeners')
