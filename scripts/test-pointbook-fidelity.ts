import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'

// All XLSX buffers and configuration stay in memory; no bootstrap or hardware providers.
const cfg = new ConfigStore({ dbPath: ':memory:' }), sink = new Sink({ config: cfg })
try {
  const source = cfg.createObject('mock fidelity source', 'mock.invalid', 502)
  const g = cfg.createGroup(source.id, 'wide points', 3, 100, 8, 'read', 2)
  cfg.createRegister(g.id, source.id, 'zero factor', 3, 100, 'uint32', { quantity: 8, factor: 0, offset: -3 })
  cfg.createRegister(g.id, source.id, '64-bit LE', 3, 104, 'float64-LE', { quantity: Number.MAX_SAFE_INTEGER })
  const target = cfg.createObject('mock fidelity target', 'mock.invalid', 502, 'master', { slaveId: 9 })
  const exported = await sink.exportPointSheet(source.id), result = await sink.importPointBook(target.id, exported.buffer)
  assert.equal(result.errors.length, 0)
  const restoredGroup = cfg.listGroups(target.id)[0], restored = cfg.listRegistersByObject(target.id)
  const failures: string[] = []
  if (restoredGroup.slaveId !== 2) failures.push('group slaveId lost')
  if (restored.find(r => r.alias === 'zero factor')?.quantity !== 8 || restored.find(r => r.alias === '64-bit LE')?.quantity !== Number.MAX_SAFE_INTEGER) failures.push('independent quantity metadata lost')
  if (restored.find(r => r.alias === 'zero factor')?.factor !== 0) failures.push('zero factor changed')
  if (restoredGroup.startAddress !== 100 || restoredGroup.quantity !== 8 || restored.length !== 2) failures.push('complete multiword range or sparse point count changed')
  assert.deepEqual(failures, [], 'XLSX export/import must preserve explicit source, metadata, zero factor and complete range')
  const qg = cfg.createGroup(source.id, 'q31 at edge', 4, 65534, 2, 'read', 7)
  cfg.createRegister(qg.id, source.id, 'q31 LE', 4, 65534, 'q31_LE', { quantity: 37, factor: -0.125, offset: 1.5, decimalPlaces: 3 })
  const leg = cfg.createGroup(source.id, '64-bit edge', 3, 65532, 4, 'read', 247)
  cfg.createRegister(leg.id, source.id, '64-bit legacy LE', 3, 65532, 'uint64_LE')
  for (const fc of [1, 2]) {
    const bg = cfg.createGroup(source.id, 'bits ' + fc, fc, 10, 2001, 'read', fc + 1)
    cfg.createRegister(bg.id, source.id, 'bit ' + fc, fc, 10, 'uint16')
  }
  const pad = cfg.createGroup(source.id, 'padded range', 3, 40, 30, 'read', 3)
  cfg.createRegister(pad.id, source.id, 'inside padded range', 3, 50, 'uint32', { quantity: 1 })
  cfg.createGroup(source.id, 'empty explicit group', 4, 20, 3, 'read', 9)
  const p0 = cfg.listRegisters(g.id)[0]
  cfg.updateRegister(p0.id, { enumJson: '{"0":"off","1":"on"}', unit: 'A', decimalPlaces: 0 })
  cfg.createRule(p0.id, '>', 10, 'raw threshold')
  cfg.createRule(p0.id, '<', -10, 'raw low')
  const sameAddress = cfg.createGroup(source.id, 'other source same address', 3, 100, 8, 'read', 4)
  const otherPoint = cfg.createRegister(sameAddress.id, source.id, 'other source point', 3, 100, 'uint32', { quantity: 2, factor: 0, offset: 0 })
  cfg.createRule(otherPoint.id, '>=', 100, 'other source alarm')
  const book = (await sink.exportPointSheet(source.id)).buffer
  const shape = (id: number) => cfg.listGroups(id).map(group => ({
    name: group.name, slaveId: group.slaveId, functionCode: group.functionCode, startAddress: group.startAddress, quantity: group.quantity,
    points: cfg.listRegisters(group.id).map(({ id, groupId, objectId, ...point }) => ({ ...point,
      alarms: cfg.listRules().filter(rule => rule.registerId === id).map(({ id, registerId, ...rule }) => rule) }))
  }))
  const expected = shape(source.id), targetBefore = cfg.getObject(target.id)
  let rangeUpdates = 0
  const updateGroup = cfg.updateGroup.bind(cfg)
  try {
    cfg.updateGroup = (...args) => { rangeUpdates++; return updateGroup(...args) }
    const restored = await sink.importPointBook(target.id, book)
    assert.deepEqual([restored.errors.length, restored.warnings.length], [0, 0])
    assert.equal(restored.groups, expected.length)
    assert.equal(restored.registers, cfg.listRegistersByObject(source.id).length)
    assert.deepEqual(shape(target.id), expected)
    assert.equal(rangeUpdates, 0, 'never call updateGroup to refill fabricated placeholder points or trim sparse rows')
    assert.deepEqual(cfg.getObject(target.id), targetBefore, 'device connection and source settings remain untouched')
  } finally { cfg.updateGroup = updateGroup }
  const third = cfg.createObject('mock second roundtrip', 'mock.invalid', 502)
  assert.equal((await sink.importPointBook(third.id, (await sink.exportPointSheet(target.id)).buffer)).errors.length, 0)
  assert.deepEqual(shape(third.id), expected, 'export/reopen/import twice keeps modeled fields, sparse/empty groups and alarm ownership')

  const change = async (mutate: (wb: ExcelJS.Workbook) => void) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(book as any); mutate(wb)
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
  const legacy = await change(wb => {
    const ws = wb.getWorksheet('wide points')!
    ws.getCell('B2').value = ''; ws.getCell('D2').value = ''; ws.getCell('F2').value = ''; ws.getCell('H2').value = ''
    ws.getCell('I4').value = ''; ws.getCell('I5').value = ''; ws.getCell('I6').value = ''
    ws.getCell('D5').value = ''; ws.getCell('E5').value = ''
  })
  const legacyResult = await sink.importPointBook(target.id, legacy)
  assert.equal(legacyResult.errors.length, 0); assert.equal(legacyResult.warnings.length, 3)
  const legacyGroup = cfg.listGroups(target.id).find(g => g.name === 'wide points')!, legacyPoint = cfg.listRegisters(legacyGroup.id)[0]
  assert.deepEqual([legacyGroup.slaveId, legacyGroup.functionCode, legacyGroup.startAddress, legacyGroup.quantity], [1, 3, 100, 8])
  assert.deepEqual([legacyPoint.quantity, legacyPoint.factor, legacyPoint.offset], [1, 1, 0])
  // A numeric-looking string is never accepted by partial parseInt/parseFloat fallback.
  const invalidCells: Array<[string, string | number]> = [
    ...[0, -1, 1.5, '2x', '2.0', 'Infinity', '9007199254740992'].map(v => ['I5', v] as [string, string | number]),
    ...[0, -1, 248, 2.5, '2x'].map(v => ['B2', v] as [string, string | number]),
    ['D5', 'NaN'], ['D5', '0x10'], ['D5', '1.2oops'], ['E5', 'Infinity'], ['H5', '100x'], ['G5', 4], ['B5', 'unknown'],
    ['H2', 1], ['H2', 0], ['H2', ''], ['F2', -1], ['F2', 65535], ['J5', 9], ['I4', '字宽'], ['I4', ''], ['C2', '从站'], ['F5', 'broken enum']
  ]
  const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules(), logs: cfg.listLogs() })
  let transactions = 0
  const apply = cfg.applyPointBookImport.bind(cfg)
  try {
    cfg.applyPointBookImport = (...args) => { transactions++; return apply(...args) }
    for (const [address, value] of invalidCells) {
      const buffer = await change(wb => { wb.getWorksheet('wide points')!.getCell(address).value = value })
      const before = snapshot(), txBefore = transactions, invalid = await sink.importPointBook(target.id, buffer)
      assert.ok(invalid.errors.length, address + '=' + value); assert.deepEqual([invalid.groups, invalid.registers], [0, 0])
      assert.equal(snapshot(), before); assert.equal(transactions, txBefore, 'validation completes before even starting the replacement')
    }
    const overflow = await change(wb => { wb.getWorksheet('64-bit edge')!.getCell('H5').value = 65534 })
    const invalid = await sink.importPointBook(target.id, overflow); assert.ok(invalid.errors.some(e => /65535/.test(e)))
  } finally { cfg.applyPointBookImport = apply }
  const zeros = await change(wb => { const ws = wb.getWorksheet('wide points')!; ws.getCell('D5').value = '0'; ws.getCell('E5').value = '0'; ws.getCell('I5').value = '0002' })
  assert.equal((await sink.importPointBook(target.id, zeros)).errors.length, 0)
  const zg = cfg.listGroups(target.id).find(g => g.name === 'wide points')!, zp = cfg.listRegisters(zg.id)[0]
  assert.deepEqual([zp.factor, zp.offset, zp.quantity, zg.quantity], [0, 0, 2, 8])
} finally { (cfg as any).db.close() }
console.log('POINTBOOK FIDELITY OK: exact group source/range, safe quantity metadata, zero/negative factors, sparse/empty groups, q31/32/64 BE/LE, all areas, same-address sources and alarms, double roundtrip, legacy defaults and invalid-input isolation (memory only)')
