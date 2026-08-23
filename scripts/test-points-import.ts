import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import { parsePointCsv } from '../packages/core/src/index.ts'

// ============================================================
// 点表导入回归：CSV 解析 + 语义批量更新（按 area+address 匹配）
// ============================================================

// 1) CSV 解析
{
  const csv = `area,address,alias,data_type,unit,factor,offset,enum
holding-register,0xE025,mc_state,uint16,,1,0,10:CONST_SPEED;11:CONST_TORQUE
holding-register,0x0000,omega_mech,int16,rpm,1,0,
holding-register,0x0001,iq,q15,A,13.75,0,
`
  const rows = parsePointCsv(csv)
  if (rows.length !== 3) throw new Error('row count: ' + rows.length)
  if (rows[0].address !== 0xE025) throw new Error('hex address: ' + rows[0].address)
  if (rows[0].enumMap?.['10'] !== 'CONST_SPEED') throw new Error('enum parse: ' + JSON.stringify(rows[0].enumMap))
  if (rows[2].factor !== 13.75) throw new Error('factor parse: ' + rows[2].factor)
  if (rows[2].dataType !== 'q15') throw new Error('data_type parse: ' + rows[2].dataType)
  if (rows[2].unit !== 'A') throw new Error('unit parse: ' + rows[2].unit)
  console.log('1) CSV parse OK: ' + rows.length + ' rows')
}

// 2) importPoints 语义更新（含未匹配地址跳过）
{
  const ctx = new Context()
  await ctx.plugin(configPlugin, { dbPath: ':memory:' })
  const cfg = ctx.get('config', false)
  const obj = cfg.createObject('dev', '127.0.0.1', 502)
  const g = cfg.createGroup(obj.id, 'g', 3, 0, 5)
  for (let i = 0; i < 5; i++) cfg.createRegister(g.id, obj.id, null, 3, i)

  const report = cfg.importPoints(obj.id, [
    { functionCode: 3, address: 0, alias: 'omega_mech', dataType: 'int16', unit: 'rpm', factor: 1, offset: 0, enumMap: null },
    { functionCode: 3, address: 1, alias: 'iq', dataType: 'q15', unit: 'A', factor: 13.75, offset: 0, enumMap: null },
    { functionCode: 3, address: 2, alias: 'mc_state', dataType: 'uint16', unit: null, factor: 1, offset: 0, enumMap: { '10': 'CONST_SPEED' } },
    { functionCode: 3, address: 99, alias: 'missing', dataType: 'int16' },
  ])
  if (report.updated !== 3 || report.skipped !== 1) throw new Error('report: ' + JSON.stringify(report))

  const regs = cfg.listRegistersByObject(obj.id)
  const r0 = regs.find((r) => r.startAddress === 0)!
  const r1 = regs.find((r) => r.startAddress === 1)!
  const r2 = regs.find((r) => r.startAddress === 2)!
  if (r0.alias !== 'omega_mech' || r0.unit !== 'rpm') throw new Error('r0 semantics: ' + JSON.stringify(r0))
  if (r1.dataType !== 'q15' || r1.factor !== 13.75 || r1.unit !== 'A') throw new Error('r1 semantics: ' + JSON.stringify(r1))
  if (r2.enumJson !== JSON.stringify({ '10': 'CONST_SPEED' })) throw new Error('r2 enum: ' + r2.enumJson)
  console.log('2) importPoints OK: updated=' + report.updated + ', skipped=' + report.skipped)
}

console.log('POINTS IMPORT TEST OK')
process.exit(0)
