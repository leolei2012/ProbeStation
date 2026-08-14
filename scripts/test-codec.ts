import { DATA_TYPES, decodeRegister, encodeRegister, registerWidth, toHex } from '../packages/core/src/codec.ts'

let fail = 0
function roundTrip(type: string, value: number, tol = 1e-3) {
  const words = encodeRegister(type, value)
  const decoded = decodeRegister(type, words)
  const ok = Math.abs(decoded - value) <= tol
  if (!ok) fail++
  console.log(type + ' ' + value + ' -> [' + words.join(',') + '] -> ' + decoded + (ok ? ' OK' : ' MISMATCH'))
}

roundTrip('int16', -1)
roundTrip('int16', 32767)
roundTrip('int16', -32768)
roundTrip('uint16', 0)
roundTrip('uint16', 65535)
roundTrip('int32', -1)
roundTrip('int32', 2147483647)
roundTrip('int32', -2147483648)
roundTrip('uint32', 4294967295)
roundTrip('float32', 3.14)
roundTrip('float32', -0.5)
roundTrip('float16', 1.5)
roundTrip('float16', -2)
roundTrip('float16', 0.5)

console.log('registerWidth int16 =', registerWidth('int16'), '| int32 =', registerWidth('int32'))
console.log('DATA_TYPES =', DATA_TYPES.join(','))
console.log('toHex(0x12ab) =', toHex(0x12ab))
// 32-bit merge check: 0x1234 (hi) + 0x5678 (lo) big-endian = 305419896
console.log('decode int32 [0x1234,0x5678] =', decodeRegister('int32', [0x1234, 0x5678]), '(expect 305419896)')
console.log('decode float32 [0x4048,0xf5c3] =', decodeRegister('float32', [0x4048, 0xf5c3]), '(expect ~3.14)')
console.log(fail === 0 ? 'CODEC TEST OK' : 'CODEC TEST FAILED: ' + fail)
process.exit(fail === 0 ? 0 : 1)
