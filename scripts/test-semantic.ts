import { decodeRegister, encodeRegister, invertSemantic, parseEnum, registerWidth, resolveSemantic } from '../packages/core/src/index.ts'

// ============================================================
// 语义层回归：Q1.15 编解码 + scale(×factor+offset) + enum 翻译
// ============================================================

// 1) Q1.15：0.5 ↔ 16384
{
  if (registerWidth('q15') !== 1) throw new Error('q15 width should be 1')
  const words = encodeRegister('q15', 0.5)
  if (words[0] !== 16384) throw new Error('q15 encode 0.5 -> ' + words[0])
  const back = decodeRegister('q15', words)
  if (Math.abs((back as number) - 0.5) > 1e-4) throw new Error('q15 decode -> ' + back)
  console.log('1) Q1.15 encode/decode OK (0.5 <-> 16384)')
}

// 2) Q1.15 + factor=13.75 + unit=A：raw 16384 -> 0.5 -> 6.875 A（iq 场景）
{
  const reg = { dataType: 'q15', factor: 13.75, offset: 0, unit: 'A', enumMap: null }
  const r = resolveSemantic(reg, 0.5)
  if (Math.abs((r.value as number) - 6.875) > 1e-6) throw new Error('q15*13.75 -> ' + r.value)
  if (r.unit !== 'A') throw new Error('unit -> ' + r.unit)
  console.log('2) Q1.15 × 13.75 → ' + r.value + ' ' + r.unit + ' OK')
}

// 3) enum：10 -> CONST_SPEED
{
  const reg = { dataType: 'uint16', factor: 1, offset: 0, unit: null, enumMap: parseEnum('{"10":"CONST_SPEED","11":"CONST_TORQUE"}') }
  const r = resolveSemantic(reg, 10)
  if (r.label !== 'CONST_SPEED') throw new Error('enum label -> ' + r.label)
  if (r.value !== 10) throw new Error('enum value -> ' + r.value)
  console.log('3) enum 10 -> CONST_SPEED OK')
}

// 4) factor=0.1 + unit=℃：254 -> 25.4℃；逆变换 25.4 -> 254
{
  const reg = { dataType: 'int16', factor: 0.1, offset: 0, unit: '℃', enumMap: null }
  const r = resolveSemantic(reg, 254)
  if (Math.abs((r.value as number) - 25.4) > 1e-9) throw new Error('scale -> ' + r.value)
  const raw = invertSemantic(reg, 25.4)
  if (Math.abs(raw - 254) > 1e-9) throw new Error('invert -> ' + raw)
  console.log('4) scale 254 -> 25.4℃ ; invert 25.4 -> 254 OK')
}

// 5) offset：值 = raw×factor + offset；逆变换 (val-offset)/factor
{
  const reg = { dataType: 'int16', factor: 2, offset: 3, unit: null, enumMap: null }
  const r = resolveSemantic(reg, 10)
  if (r.value !== 23) throw new Error('factor+offset -> ' + r.value)
  if (invertSemantic(reg, 23) !== 10) throw new Error('invert factor+offset')
  console.log('5) factor=2 offset=3：10 -> 23 -> 10 OK')
}

// 6) 无语义字段（factor=1 offset=0 无 enum）→ 值原样返回（向后兼容）
{
  const reg = { dataType: 'int16', factor: 1, offset: 0, unit: null, enumMap: null }
  const r = resolveSemantic(reg, -138)
  if (r.value !== -138 || r.label !== null || r.unit !== null) throw new Error('passthrough -> ' + JSON.stringify(r))
  console.log('6) 无语义 passthrough -138 OK')
}

console.log('SEMANTIC TEST OK')
process.exit(0)
