import { DATA_TYPES, decodeRegister, encodeRegister, toHex } from '../packages/core/src/codec.ts'

let fail = 0
function roundTrip(type: string, value: number, tol = 1e-3) {
  const word = encodeRegister(type, value)
  const decoded = decodeRegister(type, word)
  const ok = Math.abs(decoded - value) <= tol
  if (!ok) fail++
  console.log(type + ' ' + value + ' -> [' + word + '] -> ' + decoded + (ok ? ' OK' : ' MISMATCH'))
}

roundTrip('int16', -1)
roundTrip('int16', 32767)
roundTrip('int16', -32768)
roundTrip('uint16', 0)
roundTrip('uint16', 65535)
roundTrip('float16', 1.5)
roundTrip('float16', -2)
roundTrip('float16', 0.5)

console.log('DATA_TYPES =', DATA_TYPES.join(','))
console.log('toHex(0x12ab) =', toHex(0x12ab))
console.log('decode int16 0xffff =', decodeRegister('int16', 0xffff), '(expect -1)')
console.log('decode float16 15872 =', decodeRegister('float16', 15872), '(expect 1.5)')
console.log(fail === 0 ? 'CODEC TEST OK' : 'CODEC TEST FAILED: ' + fail)
process.exit(fail === 0 ? 0 : 1)
