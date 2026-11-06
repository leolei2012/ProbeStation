import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'

// Memory-only workbook identity regression: never starts the application or real providers.
const cfg = new ConfigStore({ dbPath: ':memory:' }), sink = new Sink({ config: cfg })
try {
  const unrelated = cfg.createObject('mock unrelated identity', 'mock.invalid', 502), ug = cfg.createGroup(unrelated.id, 'unrelated', 3, 50, 1)
  const originalUnrelated = cfg.createRegister(ug.id, unrelated.id, 'keep', 3, 50)
  const source = cfg.createObject('mock point identity', 'mock.invalid', 502), group = cfg.createGroup(source.id, 'Views', 3, 0, 4)
  const a = cfg.createRegister(group.id, source.id, 'view', 3, 0, 'uint16')
  const b = cfg.createRegister(group.id, source.id, 'view', 3, 0, 'uint32-LE', { factor: 0, quantity: 8 })
  cfg.createRule(a.id, '>', 10, 'first definition alarm'); cfg.createRule(a.id, '<', -10, 'first low')
  cfg.createRule(b.id, '<', 100, 'second definition alarm'); cfg.createRule(b.id, '!=', 12, 'second other')
  const g2 = cfg.createGroup(source.id, 'Views', 3, 0, 4, 'read', 2)
  const c = cfg.createRegister(g2.id, source.id, 'view', 3, 0, 'uint16', { factor: 2 })
  const d = cfg.createRegister(g2.id, source.id, 'view', 3, 0, 'uint32-LE', { offset: 3 })
  cfg.createRule(c.id, '>=', 20, 'other slave first'); cfg.createRule(d.id, '==', 42, 'other slave second')
  await assert.doesNotReject(() => sink.exportPointSheet(source.id), 'same-sheet same-address definitions need file-local identity for independent alarms')
  const open = async (buffer: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any); return wb }
  const mutate = async (buffer: Buffer, change: (wb: ExcelJS.Workbook) => void) => { const wb = await open(buffer); change(wb); return Buffer.from(await wb.xlsx.writeBuffer()) }
  const book = (await sink.exportPointSheet(source.id)).buffer, wb = await open(book), sheets = wb.worksheets.slice(2)
  const pointIds = sheets.flatMap(ws => [5, 6].map(row => String(ws.getCell(row, 12).value)))
  assert.deepEqual(pointIds, ['p1', 'p2', 'p3', 'p4']); assert.equal(wb.getWorksheet('告警规则')!.getCell('H1').value, '点位标识')
  assert.ok(a.id > 1); assert.equal(sheets[0].getCell('L5').value, 'p1', 'identifiers start in this file, independently of database IDs')
  for (const sheet of sheets) assert.equal(sheet.getCell('L4').value, '点位标识')
  const sort = <T>(values: T[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const shape = (id: number) => cfg.listGroups(id).map(g => ({ name: g.name, slaveId: g.slaveId, points: sort(cfg.listRegisters(g.id).map(({ id, groupId, objectId, ...point }) => ({ ...point,
    alarms: sort(cfg.listRules().filter(r => r.registerId === id).map(({ id, registerId, ...rule }) => rule)) }))) }))
  const expected = shape(source.id), target = cfg.createObject('mock identity target', 'mock.invalid', 502)
  const check = async (buffer: Buffer) => {
    const report = await sink.importPointBook(target.id, buffer); assert.equal(report.errors.length, 0, report.errors.join('; ')); assert.equal(report.registers, 4)
    assert.deepEqual(shape(target.id), expected)
    for (const r of cfg.listRegistersByObject(target.id)) assert.equal(Object.hasOwn(r, 'localId'), false, 'file identities are not stored in the database')
  }
  await check(book)
  await check((await sink.exportPointSheet(target.id)).buffer)
  await check(await mutate(book, b => {
    const ws = b.worksheets[2], first = (ws.getRow(5).values as any[]).slice(), second = (ws.getRow(6).values as any[]).slice()
    ws.getRow(5).values = second; ws.getRow(6).values = first
  }))
  await check(await mutate(book, b => { b.worksheets[2].spliceRows(5, 0, []) }))
  await check(await mutate(book, b => {
    const name = b.worksheets[2].name; b.worksheets[2].name = 'renamed'
    b.getWorksheet('告警规则')!.eachRow((r, i) => { if (i > 1 && r.getCell(7).value === name) r.getCell(7).value = 'renamed' })
  }))
  await check(await mutate(book, b => {
    // An explicit globally unique ID can select a point without the optional sheet condition.
    b.getWorksheet('告警规则')!.eachRow((r, i) => { if (i > 1) r.getCell(7).value = '' })
  }))
  await check(await mutate(book, b => {
    b.worksheets[2].getCell('L5').value = 'custom_view-01'
    b.getWorksheet('告警规则')!.eachRow((r, i) => { if (i > 1 && r.getCell(8).value === 'p1') r.getCell(8).value = 'custom_view-01' })
  }))
  const previous = cfg.listRegistersByObject(target.id), previousRules = cfg.listRules().filter(r => previous.some(p => p.id === r.registerId))
  const appended = await sink.importPointBook(target.id, book, false)
  assert.equal(appended.errors.length, 0); assert.equal(cfg.listRegistersByObject(target.id).length, 8)
  for (const point of previous) assert.deepEqual(cfg.getRegister(point.id), point, 'reusing file IDs during append never targets old database rows')
  for (const rule of previousRules) assert.ok(cfg.listRules().some(r => r.id === rule.id && r.registerId === rule.registerId))
  await check(book)
  const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules(), logs: cfg.listLogs() })
  let transactions = 0
  const apply = cfg.applyPointBookImport.bind(cfg)
  const reject = async (buffer: Buffer) => {
    const before = snapshot(), count = transactions, report = await sink.importPointBook(target.id, buffer)
    assert.ok(report.errors.length); assert.deepEqual([report.groups, report.registers], [0, 0]); assert.equal(snapshot(), before); assert.equal(transactions, count)
  }
  try {
    cfg.applyPointBookImport = (...args) => { transactions++; return apply(...args) }
    for (const change of [
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L6').value = 'p1' },
      (b: ExcelJS.Workbook) => { b.worksheets[3].getCell('L5').value = 'p1' },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L4').value = '' },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L4').value = 'register_id' },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L5').value = '' },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L5').value = 'p1 ' },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getCell('L5').value = 'a'.repeat(129) },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H1').value = '' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H1').value = 'register_id' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H2').value = 'missing' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H2').value = 'P1' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H2').value = 'p3' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H2').value = '' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('H2').value = ' ' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('G2').value = 'Views_2' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.getCell('C2').value = 1 },
      (b: ExcelJS.Workbook) => { b.worksheets[2].getRow(5).values = []; b.worksheets[2].getCell('L5').value = 'p1' },
      (b: ExcelJS.Workbook) => { b.getWorksheet('告警规则')!.addRow(['', '', '', '', '', '', '', 'p1']) },
    ]) await reject(await mutate(book, change))
    const legacy = (b: ExcelJS.Workbook, sheetColumn: boolean) => {
      for (const ws of b.worksheets.slice(2)) ws.spliceColumns(12, 1)
      b.getWorksheet('告警规则')!.spliceColumns(sheetColumn ? 8 : 7, sheetColumn ? 1 : 2)
    }
    await reject(await mutate(book, b => legacy(b, true)))
    await reject(await mutate(book, b => legacy(b, false)))
    const unique = cfg.createObject('mock legacy unique', 'mock.invalid', 502), un = cfg.createGroup(unique.id, 'single', 4, 10, 1)
    const up = cfg.createRegister(un.id, unique.id, 'unique point', 4, 10); cfg.createRule(up.id, '>', 1, 'unique rule')
    for (const sheetColumn of [false, true]) {
      const old = await mutate((await sink.exportPointSheet(unique.id)).buffer, b => legacy(b, sheetColumn))
      assert.equal((await sink.importPointBook(target.id, old)).errors.length, 0); assert.deepEqual(shape(target.id), shape(unique.id))
      await reject(await mutate(old, b => { b.getWorksheet('告警规则')!.getCell('H1').value = '点位标识'; b.getWorksheet('告警规则')!.getCell('H2').value = 'missing' }))
    }
    await check(book)
  } finally { cfg.applyPointBookImport = apply }
  assert.deepEqual(cfg.getRegister(originalUnrelated.id), originalUnrelated)
} finally { (cfg as any).db.close() }
console.log('POINTBOOK IDENTITY OK: workbook-local IDs, same-sheet same-address definitions with independent alarms, duplicate group/source isolation, double roundtrip/reordered rows, explicit selector consistency, legacy uniqueness and invalid input before transactions; memory only')
