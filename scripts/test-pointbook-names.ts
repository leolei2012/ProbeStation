import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { assertExportableGroupName, createSheetNameAllocator } from '../packages/sink/src/sheet-names.ts'

// Isolated config only: no application bootstrap, files, sockets or devices.
const cfg = new ConfigStore({ dbPath: ':memory:' }), sink = new Sink({ config: cfg })
try {
  const failures: string[] = []
  const source = cfg.createObject('mock duplicate names', 'mock.invalid', 502)
  for (const slave of [1, 2]) {
    const group = cfg.createGroup(source.id, 'same group', 3, 0, 1, 'read', slave)
    const point = cfg.createRegister(group.id, source.id, 'source ' + slave, 3, 0)
    cfg.createRule(point.id, '>', slave, 'rule ' + slave)
  }
  try { await sink.exportPointSheet(source.id) } catch { failures.push('duplicate group names prevent export') }
  const spaced = cfg.createObject('mock literal names', 'mock.invalid', 502)
  for (const [i, name] of ['RO', ' RO '].entries()) {
    const group = cfg.createGroup(spaced.id, name, 3, 0, 1, 'read', i + 1)
    const point = cfg.createRegister(group.id, spaced.id, 'point ' + i, 3, 0)
    cfg.createRule(point.id, '>', i + 1, 'rule ' + i)
  }
  const target = cfg.createObject('mock restored names', 'mock.invalid', 502)
  const result = await sink.importPointBook(target.id, (await sink.exportPointSheet(spaced.id)).buffer)
  const restored = cfg.listRegistersByObject(target.id)
  if (result.errors.length || restored.some(point => cfg.listRules().filter(rule => rule.registerId === point.id).length !== 1)) failures.push('trimming alarm group names silently assigns a rule to the wrong group')
  assert.deepEqual(failures, [], 'sheet display names and original group identities must remain separate')
  const shape = (id: number) => cfg.listGroups(id).map(g => ({ name: g.name, slaveId: g.slaveId, functionCode: g.functionCode, startAddress: g.startAddress, quantity: g.quantity,
    points: cfg.listRegisters(g.id).map(({ id, groupId, objectId, ...point }) => ({ ...point, alarms: cfg.listRules().filter(r => r.registerId === id).map(({ id, registerId, ...rule }) => rule) })) }))
  assert.deepEqual(shape(target.id), shape(spaced.id), 'literal group names and each alarm must match, not just rule counts')
  const names = ['plain', 'same', 'same', 'RO', 'ro', 'A/B', 'A:B', 'A_B', 'X'.repeat(31) + 'first', 'X'.repeat(31) + 'second',
    '设备信息', '告警规则', '分组_设备信息', '分组_告警规则', 'History', 'history', "'leading", "trailing'", "'both'", 'x'.repeat(30) + "'after truncation", '🙂'.repeat(16) + 'A', '🙂'.repeat(16) + 'B', ' RO ']
  const many = cfg.createObject('mock name collision matrix', 'mock.invalid', 502)
  for (const [i, name] of names.entries()) {
    const group = cfg.createGroup(many.id, name, 3, 0, 2, 'read', i + 1), p = cfg.createRegister(group.id, many.id, 'point ' + i, 3, 0, 'uint32')
    cfg.createRule(p.id, '>', i + 0.5, 'owner ' + i)
  }
  const open = async (buffer: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any); return wb }
  const exported = (await sink.exportPointSheet(many.id)).buffer, wb = await open(exported)
  const tabs = wb.worksheets.map(ws => ws.name)
  assert.equal(tabs.length, names.length + 2); assert.equal(new Set(tabs.map(s => s.toLowerCase())).size, tabs.length)
  for (const tab of tabs) {
    assert.ok(tab.length <= 31 && !/[\\/:*?\[\]\u0000-\u001f\u007f]/.test(tab) && !/^'|'$/.test(tab), tab)
    assert.ok(![...tab].some(c => { const v = c.codePointAt(0)!; return v >= 0xd800 && v <= 0xdfff }), 'no truncated surrogate pairs')
  }
  assert.equal(tabs[2], 'plain'); assert.equal(tabs.some(s => s.toLowerCase() === 'history'), false)
  assert.deepEqual(wb.worksheets.slice(2).map(ws => ws.getCell('B1').value), names, 'B1 always keeps the original group name')
  const alarms = wb.getWorksheet('告警规则')!
  assert.equal(alarms.getCell('G1').value, '点位工作表')
  for (let i = 0; i < names.length; i++) { assert.equal(alarms.getCell(i + 2, 1).value, names[i]); assert.equal(alarms.getCell(i + 2, 7).value, tabs[i + 2]) }
  assert.deepEqual((await open((await sink.exportPointSheet(many.id)).buffer)).worksheets.map(ws => ws.name), tabs, 'allocation is deterministic for the same ordered groups')
  assert.equal((await sink.importPointBook(target.id, exported)).errors.length, 0)
  assert.deepEqual(shape(target.id), shape(many.id), 'same-name same-address sources keep their own rules')
  const second = cfg.createObject('mock second name roundtrip', 'mock.invalid', 502)
  assert.equal((await sink.importPointBook(second.id, (await sink.exportPointSheet(target.id)).buffer)).errors.length, 0)
  assert.deepEqual(shape(second.id), shape(many.id))
  const allocate = createSheetNameAllocator(), allocated = Array.from({ length: 1000 }, () => allocate('long'.repeat(12)))
  assert.equal(new Set(allocated.map(s => s.toLowerCase())).size, 1000); assert.ok(allocated.every(s => s.length <= 31))
  const mutate = async (buffer: Buffer, change: (wb: ExcelJS.Workbook) => void) => { const copy = await open(buffer); change(copy); return Buffer.from(await copy.xlsx.writeBuffer()) }
  const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules(), logs: cfg.listLogs() })
  const reject = async (buffer: Buffer) => {
    const before = snapshot(), result = await sink.importPointBook(target.id, buffer)
    assert.ok(result.errors.length); assert.deepEqual([result.groups, result.registers], [0, 0]); assert.equal(snapshot(), before)
  }
  // Old six-column workbooks are supported only when literal group/FC/address selects one point.
  const oldSpaced = await mutate((await sink.exportPointSheet(spaced.id)).buffer, b => b.getWorksheet('告警规则')!.spliceColumns(7, 2))
  assert.equal((await sink.importPointBook(second.id, oldSpaced)).errors.length, 0); assert.deepEqual(shape(second.id), shape(spaced.id))
  await reject(await mutate(exported, b => b.getWorksheet('告警规则')!.spliceColumns(7, 2)))
  for (const change of [
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G1').value = '' },
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G1').value = 'unknown binding' },
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G2').value = 'missing tab' },
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G2').value = tabs[3] },
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G2').value = ' ' },
    (b: ExcelJS.Workbook) => { b.getWorksheet(tabs[2])!.name = 'renamed tab' },
    (b: ExcelJS.Workbook) => { b.removeWorksheet(tabs[2]) },
    (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('A2').value = 'plain ' },
  ]) await reject(await mutate(exported, change))
  const upper = await mutate(exported, b => { const row = b.getWorksheet('告警规则')!.getRow(2); row.getCell(7).value = String(row.getCell(7).value).toUpperCase() })
  assert.equal((await sink.importPointBook(second.id, upper)).errors.length, 0); assert.deepEqual(shape(second.id), shape(many.id))
  // Blank legacy group headers retain their old fallback, but the change is visible as a warning.
  const fallback = await mutate((await sink.exportPointSheet(spaced.id)).buffer, b => { b.worksheets[2].getCell('B1').value = '' })
  const fallbackResult = await sink.importPointBook(second.id, fallback)
  assert.equal(fallbackResult.errors.length, 0); assert.ok(fallbackResult.warnings.some(w => /未提供分组名/.test(w)))
  // Legacy alarms without point identity remain ambiguous even though new files can carry identities.
  const duplicate = cfg.createObject('mock same-sheet duplicates', 'mock.invalid', 502), dg = cfg.createGroup(duplicate.id, 'duplicate definitions', 3, 0, 1)
  const dp = cfg.createRegister(dg.id, duplicate.id, 'first definition', 3, 0)
  cfg.createRegister(dg.id, duplicate.id, 'second definition', 3, 0)
  const noRules = (await sink.exportPointSheet(duplicate.id)).buffer
  assert.equal((await sink.importPointBook(second.id, noRules)).errors.length, 0); assert.equal(cfg.listRegistersByObject(second.id).length, 2)
  await reject(await mutate(noRules, b => { b.getWorksheet('告警规则')!.addRow(['duplicate definitions', 3, 0, '>', 1, '', 'duplicate definitions']) }))
  cfg.createRule(dp.id, '>', 1, 'ambiguous owner')
  const identified = await sink.exportPointSheet(duplicate.id)
  assert.equal((await sink.importPointBook(second.id, identified.buffer)).errors.length, 0)
  assert.deepEqual(shape(second.id), shape(duplicate.id))
  assert.throws(() => assertExportableGroupName('\ud800'), /不能保真/)
  for (const name of ['', '   ', 'bad\u0000name', 'line\nbreak', '\uffff']) {
    const bad = cfg.createObject('mock unsupported name', 'mock.invalid', 502)
    cfg.createGroup(bad.id, name, 3, 0, 1)
    const before = snapshot(); await assert.rejects(sink.exportPointSheet(bad.id), /不能保真/); assert.equal(snapshot(), before)
  }
} finally { (cfg as any).db.close() }
console.log('POINTBOOK NAMES OK: case/duplicate/sanitized/truncated/reserved/Unicode tab allocation, literal names, explicit sheet-bound alarms, two roundtrips, six-column legacy refusal/recovery, invalid/stale bindings and unsupported export identities (memory only)')
