import { DATA_TYPES, decodeRegister, encodeRegister, registerWidth, toBin, toHex } from '../packages/core/src/codec.ts'

let fail = 0
function roundTrip(type: string, value: number | bigint, tol = 1e-3) {
  const words = encodeRegister(type, value)
  const decoded = decodeRegister(type, words)
  const ok = typeof decoded === 'bigint' ? decoded === BigInt(value) : Math.abs((decoded as number) - Number(value)) <= tol
  if (!ok) fail++
  console.log(type + ' ' + String(value) + ' -> [' + words.join(',') + '] -> ' + String(decoded) + (ok ? ' OK' : ' MISMATCH'))
}

roundTrip('int16', -1)
roundTrip('int16', 32767)
roundTrip('uint16', 65535)
roundTrip('float16', 1.5)
roundTrip('int32', 2147483647)
roundTrip('int32', -2147483648)
roundTrip('uint32', 4294967295)
roundTrip('float32', 3.14)
roundTrip('int64', 9007199254740993n)
roundTrip('uint64', 18446744073709551615n)
roundTrip('float64', 3.14159265358979)
roundTrip('int32-LE', 305419896)
roundTrip('float32-LE', 3.14)
roundTrip('float64-LE', 3.14159265358979)
roundTrip('int16-LE', 4660)
roundTrip('hex16', 4660)
roundTrip('hex32-LE', 305419896)

console.log('widths 16/32/64 =', registerWidth('int16'), registerWidth('int32'), registerWidth('float64'))
console.log('DATA_TYPES =', DATA_TYPES.join(','))
console.log('toHex(0x12ab) =', toHex(0x12ab))
console.log('toBin(0x12ab) =', toBin(0x12ab), '(expect 0001001010101011)')
console.log('decode int32 [0x1234,0x5678] =', decodeRegister('int32', [0x1234, 0x5678]), '(expect 305419896)')
console.log('decode uint64 [0,0,1,0] =', decodeRegister('uint64', [0, 0, 1, 0]), '(expect 65536)')
console.log('decode int32-LE [0x5678,0x1234] =', decodeRegister('int32-LE', [0x5678, 0x1234]), '(expect 305419896)')
console.log(fail === 0 ? 'CODEC TEST OK' : 'CODEC TEST FAILED: ' + fail)
process.exit(fail === 0 ? 0 : 1)
