import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { stageMemoryConfigurationRecovery } from './fixtures/config-recovery-driver.ts'
let recovery: ReturnType<typeof stageMemoryConfigurationRecovery> | undefined


// Synthetic XLSX replacement; explicit recovery uses a new temporary fixture copy only.
let observe = false, failNotify = false
const events: Array<{ scope: string; id?: number; groups: number; registers: number; rules: number }> = []
let cfg: ConfigStore
cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => {
  if (failNotify) throw new Error('injected notification failure')
  if (observe) events.push({ scope, id, groups: cfg.listGroups(id!).length, registers: cfg.listRegistersByObject(id!).length, rules: cfg.listRules().filter(rule => cfg.listRegistersByObject(id!).some(r => r.id === rule.registerId)).length })
})
const sink = new Sink({ config: cfg })
const snapshot = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listObjects().flatMap(d => cfg.listGroups(d.id)), registers: cfg.listObjects().flatMap(d => cfg.listRegistersByObject(d.id)), rules: cfg.listRules(), logs: cfg.listLogs() })
try {
  const source = cfg.createObject('mock XLSX source', 'mock.invalid', 502), sg = cfg.createGroup(source.id, 'new group', 3, 0, 2)
  const first = cfg.createRegister(sg.id, source.id, 'valid first', 3, 0, 'uint16')
  cfg.createRegister(sg.id, source.id, 'invalid later', 3, 1, 'uint16')
  const sg2 = cfg.createGroup(source.id, 'second group', 4, 10, 1)
  cfg.createRegister(sg2.id, source.id, 'second group point', 4, 10, 'float16')
  cfg.createRule(first.id, '>', 20, 'new high'); cfg.createRule(first.id, '<', -20, 'new low')
  const target = cfg.createObject('mock XLSX target', 'mock.invalid', 502), tg = cfg.createGroup(target.id, 'keep old group', 3, 100, 1)
  const old = cfg.createRegister(tg.id, target.id, 'keep old point', 3, 100, 'uint16')
  cfg.createRule(old.id, '>', 10, 'keep old alarm')
  const oldGroup2 = cfg.createGroup(target.id, 'keep other group', 4, 200, 1)
  cfg.createRegister(oldGroup2.id, target.id, 'keep other point', 4, 200, 'uint16')
  const exported = await sink.exportPointSheet(source.id), wb = new ExcelJS.Workbook()
  observe = true
  const rejected = async (buffer: Buffer, replace = true) => {
    const before = snapshot(), count = events.length, result = await sink.importPointBook(target.id, buffer, replace)
    assert.ok(result.errors.length > 0); assert.equal(result.groups, 0); assert.equal(result.registers, 0)
    assert.ok(snapshot() === before, 'any reported row error must preserve all groups, points, alarms and logs')
    assert.equal(events.length, count)
  }
  for (const [address, value] of [['J6', 9], ['J6', -1], ['J6', 1.5], ['H6', 'oops']] as const) {
    await wb.xlsx.load(exported.buffer as any); wb.getWorksheet('new group')!.getCell(address).value = value
    await rejected(Buffer.from(await wb.xlsx.writeBuffer()))
    await rejected(Buffer.from(await wb.xlsx.writeBuffer()), false)
  }
  const empty = new ExcelJS.Workbook(), alarms = empty.addWorksheet('告警规则')
  alarms.addRow(['分组', '功能码', '起始地址', '告警条件', '原始值阈值', '告警提示'])
  await rejected(Buffer.from(await empty.xlsx.writeBuffer()))
  empty.addWorksheet('empty page'); await rejected(Buffer.from(await empty.xlsx.writeBuffer()))
  await wb.xlsx.load(exported.buffer as any); wb.removeWorksheet('告警规则')
  await rejected(Buffer.from(await wb.xlsx.writeBuffer()))
  let before = snapshot(), count = events.length
  await assert.rejects(sink.importPointBook(target.id, Buffer.from('not a workbook')))
  assert.equal(snapshot(), before); assert.equal(events.length, count)
  await assert.rejects(sink.importPointBook(999999, exported.buffer)); assert.equal(snapshot(), before)

  // A successful replacement publishes exactly once, with only the complete committed graph.
  const success = await sink.importPointBook(target.id, exported.buffer)
  assert.deepEqual([success.groups, success.registers, success.errors.length, success.warnings.length], [2, 3, 0, 0])
  assert.deepEqual(events.at(-1), { scope: 'point-book-import', id: target.id, groups: 2, registers: 3, rules: 2 })
  assert.equal(events.length, count + 1); assert.equal(cfg.getRegister(old.id), undefined)
  const targetRules = () => cfg.listRules().filter(rule => cfg.listRegistersByObject(target.id).some(r => r.id === rule.registerId))
  const sourceGraph = () => JSON.stringify([cfg.getObject(source.id), cfg.listGroups(source.id), cfg.listRegistersByObject(source.id), cfg.listRules().filter(rule => cfg.listRegistersByObject(source.id).some(r => r.id === rule.registerId))])
  const sourceBefore = sourceGraph()
  await sink.importPointBook(target.id, exported.buffer); assert.equal(targetRules().length, 2)

  // Inject failures after earlier operations have already run inside the transaction.
  const methods = ['deleteGroup', 'createGroup', 'createRegister', 'createRule'] as const
  const originals = new Map(methods.map(method => [method, cfg[method].bind(cfg)]))
  const db = (cfg as any).db, exec = db.exec.bind(db)
  for (const failure of [...methods, 'begin', 'commit'] as const) {
    before = snapshot(); count = events.length; let writes = 0
    try {
      if (failure === 'begin' || failure === 'commit') db.exec = (sql: string) => {
        if (sql === (failure === 'begin' ? 'BEGIN IMMEDIATE' : 'COMMIT')) throw new Error('injected ' + failure)
        return exec(sql)
      }
      else (cfg as any)[failure] = (...args: any[]) => { if (++writes === 2) throw new Error('injected ' + failure); return (originals.get(failure) as any)(...args) }
      await assert.rejects(sink.importPointBook(target.id, exported.buffer), /injected/)
    } finally { for (const [method, original] of originals) (cfg as any)[method] = original; db.exec = exec }
    assert.equal(snapshot(), before, failure + ' rolls back the entire replacement'); assert.equal(events.length, count)
    const retry = await sink.importPointBook(target.id, exported.buffer)
    assert.equal(retry.errors.length, 0); assert.equal(events.length, count + 1); assert.equal(targetRules().length, 2)
    assert.equal(sourceGraph(), sourceBefore, 'another device is never changed')
  }
  // Append has the same all-or-nothing behavior but preserves old IDs and rules on success.
  const previousGroups = cfg.listGroups(target.id), previousRegs = cfg.listRegistersByObject(target.id), previousRules = targetRules()
  count = events.length
  assert.equal((await sink.importPointBook(target.id, exported.buffer, false)).errors.length, 0)
  assert.equal(cfg.listGroups(target.id).length, previousGroups.length + 2); assert.equal(targetRules().length, previousRules.length + 2)
  for (const reg of previousRegs) assert.deepEqual(cfg.getRegister(reg.id), reg)
  assert.equal(events.length, count + 1)

  // After commit, callback/log exceptions are warnings, not a failed write to retry.
  try {
    failNotify = true
    const notified = await sink.importPointBook(target.id, exported.buffer)
    assert.equal(notified.errors.length, 0); assert.match(notified.warnings[0], /已提交/)
    assert.equal(cfg.listRegistersByObject(target.id).length, 3)
  } finally { failNotify = false }
  const log = cfg.log.bind(cfg)
  try {
    cfg.log = () => { throw new Error('injected log failure') }
    const logged = await sink.importPointBook(target.id, exported.buffer)
    assert.equal(logged.errors.length, 0); assert.match(logged.warnings[0], /日志写入失败/)
  } finally { cfg.log = log }

  // A rollback failure is explicitly uncertain; only the test cleans up the still-open memory transaction.
  recovery = stageMemoryConfigurationRecovery(cfg)
  before = snapshot(); count = events.length
  try {
    db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('injected uncertain transaction'); return exec(sql) }
    await assert.rejects(sink.importPointBook(target.id, exported.buffer), error => error instanceof AggregateError && /结果不确定/.test(error.message))
  } finally { db.exec = exec; exec('ROLLBACK') }
  assert.throws(snapshot, /此连接已隔离/); recovery.reopen()
  assert.equal(snapshot(), before); assert.equal(events.length, count)
  assert.equal((await sink.importPointBook(target.id, exported.buffer)).errors.length, 0)
} finally { await cfg.close(); await recovery?.close() }
console.log('POINTBOOK ATOMIC OK: later-row/empty/invalid file rejection, replace/append, full-graph notification, delete/group/point/rule/commit rollback and retry, uncertain rollback and post-commit warnings; memory/fresh-temporary SQLite and synthetic XLSX')
