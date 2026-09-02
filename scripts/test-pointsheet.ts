import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'

function assert(cond: unknown, msg: string): void { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1) } }

const cfg: any = new ConfigStore({ dbPath: ':memory:' })
const sink = new Sink({ config: cfg }) as any
sink.ctx = { config: cfg }

// 设备 + 2 组（组含别名/地址/类型/单位/enum）
const d = cfg.createObject('BOARD', '', 502, 'master', { transport: 'rtu', serialPath: 'COM6', slaveId: 1, baudRate: 9600, pollIntervalMs: 500 })

// 组1：RO，fc3 地址 0..2 (3点)
const g1 = cfg.createGroup(d.id, 'RO', 3, 0, 3)
for (let a = 0; a < 3; a++) cfg.createRegister(g1.id, d.id, a === 0 ? '电源' : (a === 1 ? '模式' : 'tick'), 3, a, 'int16', { unit: a === 0 ? '' : 'rpm', factor: 1, offset: 0, enumJson: a === 1 ? JSON.stringify({ 0: 'OFF', 1: 'ON' }) : null })
// 组2：RW fc3 地址 4096..4097
const g2 = cfg.createGroup(d.id, 'RW', 3, 4096, 2)
cfg.createRegister(g2.id, d.id, '手动开关', 3, 4096, 'int16', { unit: null })
cfg.createRegister(g2.id, d.id, '目标点', 3, 4097, 'uint16')

const exported = await sink.exportPointSheet(d.id)
assert(Buffer.isBuffer(exported.buffer) && exported.buffer.length > 200, 'export produced buffer, got len ' + exported.buffer.length)
console.log('export ok =>', exported.filename, 'bytes', exported.buffer.length)

// 导入到另一台空设备
const d2 = cfg.createObject('BOARD-2', '', 502, 'master', { transport: 'rtu', serialPath: 'COM7', slaveId: 1 })
const res = await sink.importPointBook(d2.id, exported.buffer)
assert(res.groups === 2, 'import groups=2 got ' + res.groups + ' errs=' + JSON.stringify(res.errors))
assert(res.registers === 5, 'import registers=5 got ' + res.registers + ' errs=' + JSON.stringify(res.errors))
assert(res.errors.length === 0, 'no import errors: ' + JSON.stringify(res.errors))

// 导入结果与原一致
const aRegs = cfg.listRegistersByObject(d.id)
const bRegs = cfg.listRegistersByObject(d2.id)
assert(aRegs.length === bRegs.length, 'same reg count')
for (let i = 0; i < aRegs.length; i++) {
  const x = aRegs[i], y = bRegs[i]
  const norm = (v: any) => (v == null || v === '' ? null : v)
  if (norm(x.alias) !== norm(y.alias) || x.startAddress !== y.startAddress || norm(x.dataType) !== norm(y.dataType) || norm(x.unit) !== norm(y.unit) || norm(x.enumJson) !== norm(y.enumJson) || x.factor !== y.factor || x.offset !== y.offset) {
    console.error('mismatch at ' + i, JSON.stringify(x), JSON.stringify(y)); process.exit(1)
  }
}
// 分组名&地址
const aG = cfg.listGroups(d.id).sort((m: any, n: any) => m.startAddress - n.startAddress)
const bG = cfg.listGroups(d2.id).sort((m: any, n: any) => m.startAddress - n.startAddress)
assert(aG.length === bG.length, 'groups equal')
assert((bG as any[]).some((g: any) => g.name === 'RO'), 'RO group restored')
assert((bG as any[]).some((g: any) => g.name === 'RW'), 'RW group restored')

// 用 exceljs 重新打开导出的 xlsx：确认文件真实可读、且“分组=sheet”结构成立
const E = (await import('exceljs')).default as any
const reopened = new E.Workbook()
await reopened.xlsx.load(exported.buffer)
const names = reopened.worksheets.map((w: any) => w.name)
assert(names.includes('设备信息'), 'device-info sheet present')
assert(names.includes('RO') && names.includes('RW'), 'group sheets present: ' + JSON.stringify(names))
const roSheet = reopened.getWorksheet('RO')
assert(roSheet && roSheet.rowCount >= 5, 'RO sheet has 分组头+列头+数据 (rowCount=' + (roSheet ? roSheet.rowCount : -1) + ')')
console.log('reopen OK, sheets =', JSON.stringify(names), '; RO rows =', roSheet.rowCount)

console.log('POINTSHEET ROUNDTRIP OK (导出/导入对称)')
process.exit(0)

