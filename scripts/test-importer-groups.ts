import assert from 'node:assert/strict'
import { ConfigStore } from '../packages/config/src/index.ts'
import { apply as applyImporter, parseMbp, parseMbs } from '../packages/importer/src/index.ts'
import { diagnoseDevicePoints } from '../packages/core/src/point-diagnostics.ts'
import { assertImportedPointTable } from '../packages/core/src/point-import.ts'

// Do not use test-importer.ts: its bootstrap can start real polling. This suite uses memory only.
const events: Array<{ scope: string; groups: number; registers: number }> = []
let observe = false, cfg: ConfigStore
cfg = new ConfigStore({ dbPath: ':memory:' }, scope => { if (observe) events.push({ scope, groups: cfg.listGroups(1).length, registers: cfg.listRegistersByObject(1).length }) })
let importer: any
applyImporter({ config: cfg, provide: (_name: string, service: any) => { importer = service } } as any)
const ini = '[Window1]\nFunction=03\nAddress=40001\nQuantity=2\nAlias=holding\nData Type=uint16\n[Window2]\nFunction=04\nAddress=30011\nQuantity=3\nAlias=input\nData Type=float16\n'
const xml = '<?xml version="1.0"?><ModbusPoll><Data><Function>3</Function><Address>0</Address><Quantity>2</Quantity><CellData><Cell idx="0"><Name>holding A</Name></Cell><Cell idx="1"><Name>holding B</Name></Cell></CellData><Formats><F f="1"/><F f="4"/></Formats></Data><Data><Function>4</Function><Address>10</Address><Quantity>1</Quantity><CellData><Cell idx="0"><Name>input C</Name></Cell></CellData></Data></ModbusPoll>'
const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules() })
try {
  const device = cfg.createObject('mock MBP target', 'mock.invalid', 502)
  const existingGroup = cfg.createGroup(device.id, 'existing', 3, 100, 1, 'read', 9)
  const existingPoint = cfg.createRegister(existingGroup.id, device.id, 'keep', 3, 100, 'uint16', { quantity: 8, factor: 2 })
  const rule = cfg.createRule(existingPoint.id, '>', 10, 'keep rule')
  const savedExisting = JSON.stringify([cfg.getObject(device.id), cfg.getGroup(existingGroup.id), cfg.getRegister(existingPoint.id), cfg.listRules()])
  observe = true
  const result = importer.import(device.id, 'two.mbp', Buffer.from(ini))
  assert.equal(result.groups, 2); assert.equal(result.registers, 2)
  const added = cfg.listRegistersByObject(device.id).filter(r => r.id !== existingPoint.id)
  for (const r of added) assert.equal(cfg.getGroup(r.groupId)!.functionCode, r.functionCode, 'every imported point must belong to its actual source window')
  assert.notEqual(added[0].groupId, added[1].groupId)
  assert.deepEqual(added.map(r => [r.startAddress, r.dataType, r.quantity]), [[0, 'uint16', 1], [10, 'float16', 1]], 'keep the existing one-definition-per-INI-window and register metadata behavior')
  assert.equal(JSON.stringify([cfg.getObject(device.id), cfg.getGroup(existingGroup.id), cfg.getRegister(existingPoint.id), cfg.listRules()]), savedExisting)
  assert.equal(cfg.listRules()[0].id, rule.id)
  assert.deepEqual(events, [{ scope: 'import', groups: 3, registers: 3 }], 'only one post-commit notification with the complete graph')
  assert.equal(diagnoseDevicePoints(cfg, device.id).summary.errors, 0)

  const parsed = parseMbp(Buffer.from(xml))
  assert.deepEqual(parsed.registers.map(r => r.groupIndex), [0, 0, 1])
  const beforeXml = cfg.listRegistersByObject(device.id).map(r => r.id)
  const xmlResult = importer.import(device.id, 'T.MBP', Buffer.from(xml))
  assert.deepEqual([xmlResult.groups, xmlResult.registers], [2, 3])
  const xmlPoints = cfg.listRegistersByObject(device.id).filter(r => !beforeXml.includes(r.id))
  assert.deepEqual(xmlPoints.map(r => r.alias).sort(), ['holding A', 'holding B', 'input C'])
  assert.ok(xmlPoints.every(r => cfg.getGroup(r.groupId)!.functionCode === r.functionCode))
  assert.equal(xmlPoints.find(r => r.alias === 'holding B')!.dataType, 'int16', 'legacy raw 16-bit mapping for MBP format 4 remains unchanged')
  assert.equal(JSON.stringify(parseMbp(Buffer.from('\uFEFF' + ini))), JSON.stringify(parseMbp(Buffer.from(ini))))
  const overlap = '<ModbusPoll><Data><Function>3</Function><Address>0</Address><Quantity>1</Quantity></Data><Data><Function>3</Function><Address>0</Address><Quantity>1</Quantity></Data></ModbusPoll>'
  const beforeOverlap = cfg.listGroups(device.id).length
  importer.import(device.id, 'overlap.mbp', Buffer.from(overlap))
  const overlapGroups = cfg.listGroups(device.id).slice(beforeOverlap)
  assert.equal(overlapGroups.length, 2)
  assert.ok(overlapGroups.every(g => cfg.listRegisters(g.id).length === 1), 'same FC/address/name windows retain independent groups')
  const duplicateSections = '[Window1]\nFunction=03\nAddress=40001\nAlias=first\n[Window1]\nFunction=04\nAddress=30001\nAlias=second\n'
  const duplicateParsed = parseMbp(Buffer.from(duplicateSections))
  assert.equal(duplicateParsed.groups.length, 2); assert.deepEqual(duplicateParsed.registers.map(r => r.groupIndex), [0, 1])
  assert.ok(duplicateParsed.warnings.some(w => w.includes('Duplicate')))
  const beforeDuplicate = cfg.listGroups(device.id).length
  importer.import(device.id, 'duplicate.mbp', Buffer.from(duplicateSections))
  assert.ok(cfg.listGroups(device.id).slice(beforeDuplicate).every(g => cfg.listRegisters(g.id).length === 1))

  const mbs = Buffer.alloc(120); mbs.writeUInt32LE(3, 12); mbs.writeUInt32LE(2, 16); mbs.writeUInt32LE(7, 20)
  assert.ok(parseMbs(mbs).registers.every(r => r.groupIndex === 0))
  const beforeMbs = cfg.listGroups(device.id).length
  assert.equal(importer.import(device.id, 'header.MBS', mbs).registers, 2)
  const mbsGroup = cfg.listGroups(device.id)[beforeMbs]
  assert.equal(mbsGroup.slaveId, 7, 'known source from MBS header must not be dropped to createGroup default 1')
  assert.equal(mbsGroup.mode, 'read_write'); assert.equal(cfg.getObject(device.id)!.slaveId, device.slaveId)

  // All validation is before writes; no guessing unsupported windows or missing owner indices.
  for (const invalid of [
    '[Window1]\nFunction=03\nAddress=40001\nQuantity=0',
    '[Window1]\nFunction=03\nAddress=40001\nQuantity=Infinity',
    '[Window1]\nFunction=05\nAddress=40001\nQuantity=1',
    '<ModbusPoll><Data><Address>65535</Address><Quantity>2</Quantity></Data></ModbusPoll>',
    '<ModbusPoll><Data><Quantity>1.5</Quantity></Data></ModbusPoll>',
    '<ModbusPoll><Data><Quantity>1</Data></ModbusPoll>',
  ]) {
    const before = snapshot(), count = events.length
    assert.throws(() => importer.import(device.id, 'invalid.mbp', Buffer.from(invalid)))
    assert.equal(snapshot(), before); assert.equal(events.length, count)
  }
  for (const unit of [0, 248]) {
    const bad = Buffer.from(mbs); bad.writeUInt32LE(unit, 20)
    const before = snapshot(); assert.throws(() => importer.import(device.id, 'invalid.mbs', bad)); assert.equal(snapshot(), before)
  }
  const boundary = parseMbp(Buffer.from('<ModbusPoll><Data><Address>65535</Address><Quantity>1</Quantity></Data></ModbusPoll>'))
  assert.equal(boundary.registers[0].startAddress, 65535)
  const large = parseMbp(Buffer.from('<ModbusPoll><Data><Quantity>126</Quantity></Data></ModbusPoll>'))
  assert.equal(large.registers.length, 126, 'a window can legitimately span several request PDUs')
  assertImportedPointTable(large.groups, large.registers)
  for (const quantity of [0, 65537, Infinity, 1.5]) assert.throws(() => assertImportedPointTable([{ ...large.groups[0], quantity }], []))
  for (const definition of [{ ...large.registers[0], groupIndex: -1 }, { ...large.registers[0], groupIndex: undefined }, { ...large.registers[0], functionCode: 4 }, { ...large.registers[0], dataType: 'unknown' }, { ...large.registers[0], startAddress: 125, dataType: 'uint32' }]) assert.throws(() => assertImportedPointTable(large.groups, [definition as any]))
  const emptyBefore = snapshot(), eventCount = events.length
  assert.deepEqual(importer.import(device.id, 'empty.mbp', Buffer.from('')).groups, 0)
  assert.equal(snapshot(), emptyBefore); assert.equal(events.length, eventCount)
  const draft = parseMbp(Buffer.from(ini))
  const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
  const frozen = freeze(JSON.parse(JSON.stringify(draft))), frozenText = JSON.stringify(frozen)
  ;(cfg as any).appendImportedPoints(device.id, frozen.groups, frozen.registers)
  assert.equal(JSON.stringify(frozen), frozenText)
  const beforeBadOwner = snapshot()
  assert.throws(() => (cfg as any).appendImportedPoints(device.id, draft.groups, [{ ...draft.registers[0], groupIndex: 9 }]))
  assert.equal(snapshot(), beforeBadOwner)
  assert.throws(() => importer.import(9999, 'two.mbp', Buffer.from(ini)))
  assert.equal(snapshot(), beforeBadOwner)

  // Inject later writes/commit failures: original and new rows roll back, no partial callback.
  const createRegister = cfg.createRegister.bind(cfg), createGroup = cfg.createGroup.bind(cfg)
  for (const method of ['register', 'group', 'commit']) {
    const before = snapshot(), count = events.length
    let writes = 0
    const db = (cfg as any).db, exec = db.exec.bind(db)
    try {
      if (method === 'register') cfg.createRegister = ((...args: any[]) => { if (++writes === 2) throw new Error('injected register failure'); return (createRegister as any)(...args) }) as any
      if (method === 'group') cfg.createGroup = ((...args: any[]) => { if (++writes === 2) throw new Error('injected group failure'); return (createGroup as any)(...args) }) as any
      if (method === 'commit') db.exec = (sql: string) => { if (sql === 'COMMIT') throw new Error('injected commit failure'); return exec(sql) }
      assert.throws(() => importer.import(device.id, 'two.mbp', Buffer.from(ini)), /injected/)
    } finally { cfg.createRegister = createRegister; cfg.createGroup = createGroup; db.exec = exec }
    assert.equal(snapshot(), before, method + ' failure must leave the complete configuration unchanged')
    assert.equal(events.length, count)
    importer.import(device.id, 'retry.mbp', Buffer.from(ini)); assert.equal(events.length, count + 1, 'a retry remains usable and publishes once')
  }
} finally { (cfg as any).db.close() }
// A synchronous post-commit notification failure is reported as committed-with-warning, not a failed write to retry.
let failNotification = false
const notificationCfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (failNotification) throw new Error('injected notification failure') })
try {
  const d = notificationCfg.createObject('mock callback', 'mock.invalid', 502), parsed = parseMbp(Buffer.from(ini))
  failNotification = true
  const report = notificationCfg.appendImportedPoints(d.id, parsed.groups, parsed.registers)
  assert.equal(report.groups, 2); assert.ok(report.warnings.some(w => w.includes('已提交')))
  assert.equal(notificationCfg.listGroups(d.id).length, 2); assert.equal(notificationCfg.listRegistersByObject(d.id).length, 2)
} finally { (notificationCfg as any).db.close() }
console.log('IMPORTER GROUPS OK: XML/INI source-window identity, duplicate/overlapping windows, legacy formatting, MBS source preservation, validation before writes, additive config/rule preservation and transaction rollback/retry (memory only)')
