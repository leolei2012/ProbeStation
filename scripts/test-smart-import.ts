import { guessField, parseSmartAddress, parseSmartDataType, parseSmartZone, smartParseCsv } from '../packages/core/src/index.ts'

// ============================================================
// 智能点表导入回归：列识别 + 地址/类型/存储区启发式 + 智能 CSV
// ============================================================

// 1) 列识别（中英文表头）
{
  if (guessField('变量名称') !== 'alias') throw new Error('name -> ' + guessField('变量名称'))
  if (guessField('寄存器地址') !== 'address') throw new Error('addr -> ' + guessField('寄存器地址'))
  if (guessField('DataType') !== 'dataType') throw new Error('type -> ' + guessField('DataType'))
  if (guessField('存储区') !== 'area') throw new Error('area -> ' + guessField('存储区'))
  if (guessField('单位') !== 'unit') throw new Error('unit -> ' + guessField('单位'))
  if (guessField('系数') !== 'factor') throw new Error('factor -> ' + guessField('系数'))
  if (guessField('偏移') !== 'offset') throw new Error('offset -> ' + guessField('偏移'))
  console.log('1) guessField OK')
}

// 2) 地址启发式：0x / H / PLC 逻辑地址 / %MW
{
  if (parseSmartAddress('0x64')?.address !== 100) throw new Error('0x64')
  if (parseSmartAddress('64H')?.address !== 100) throw new Error('64H')
  const a = parseSmartAddress('40001')
  if (a?.area !== 'holding-register' || a.address !== 0) throw new Error('40001 -> ' + JSON.stringify(a))
  const b = parseSmartAddress('30001')
  if (b?.area !== 'input-register' || b.address !== 0) throw new Error('30001 -> ' + JSON.stringify(b))
  const c = parseSmartAddress('%MW100')
  if (c?.address !== 100) throw new Error('%MW100 -> ' + JSON.stringify(c))
  console.log('2) parseSmartAddress OK')
}

// 3) 类型 / 存储区启发式
{
  if (parseSmartDataType('DINT') !== 'int32') throw new Error('DINT')
  if (parseSmartDataType('WORD') !== 'uint16') throw new Error('WORD')
  if (parseSmartDataType('REAL') !== 'float32') throw new Error('REAL')
  if (parseSmartDataType('Q15') !== 'q15') throw new Error('Q15')
  if (parseSmartDataType('INT') !== null) throw new Error('INT should default (null)')
  if (parseSmartZone('HR') !== 'holding-register') throw new Error('HR')
  if (parseSmartZone('AI') !== 'input-register') throw new Error('AI')
  if (parseSmartZone('0x') !== 'coil') throw new Error('0x')
  console.log('3) parseSmartDataType/Zone OK')
}

// 4) 智能 CSV：中文表头 + PLC 地址 + 混合类型 + enum
{
  const csv = `变量名称,寄存器地址,数据类型,单位,系数,偏移,枚举
目标转速,40001,INT,rpm,1,0,
母线电压,0x1000,UINT,V,0.1,0,
状态字,40003,WORD,,1,0,10:CONST_SPEED;11:CONST_TORQUE
`
  const { points, report } = smartParseCsv(csv)
  if (report.parsed !== 3) throw new Error('parsed=' + report.parsed)
  if (points[0].alias !== '目标转速' || points[0].address !== 0 || points[0].area !== 'holding-register' || points[0].dataType !== 'int16') throw new Error('row0: ' + JSON.stringify(points[0]))
  if (points[1].address !== 4096 || points[1].factor !== 0.1 || points[1].unit !== 'V' || points[1].dataType !== 'uint16') throw new Error('row1: ' + JSON.stringify(points[1]))
  if (points[2].enumMap?.['10'] !== 'CONST_SPEED' || points[2].address !== 2) throw new Error('row2: ' + JSON.stringify(points[2]))
  console.log('4) smartParseCsv OK: parsed=' + report.parsed + ', columns=' + JSON.stringify(report.columns))
}

console.log('SMART IMPORT TEST OK')
process.exit(0)
