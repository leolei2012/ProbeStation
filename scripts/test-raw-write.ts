import assert from 'node:assert/strict'
import { decodeRegister, encodeRegister, parseRawRegisterInput } from '../packages/core/src/codec'

for (const radix of ['hex', 'bin']) {
  for (const bits of [16, 32, 64]) {
    for (const suffix of ['', '-LE']) {
      const type = radix + bits + suffix
      const max = (1n << BigInt(bits)) - 1n
      for (const value of [0n, 10n, max]) {
        const text = radix === 'hex' ? '0x' + value.toString(16) : '0b' + value.toString(2)
        const parsed = parseRawRegisterInput(type, text)
        assert.equal(parsed, value)
        assert.equal(BigInt(decodeRegister(type, encodeRegister(type, parsed))), value)
      }
      assert.throws(() => parseRawRegisterInput(type, max + 1n))
      assert.throws(() => encodeRegister(type, max + 1n))
      assert.throws(() => parseRawRegisterInput(type, -1))
      assert.throws(() => parseRawRegisterInput(type, 1.5))
    }
  }
}
assert.equal(parseRawRegisterInput('hex16', 'FFFF'), 65535n)
assert.equal(parseRawRegisterInput('hex32', '0x1234 0xABCD'), 0x1234ABCDn)
assert.equal(parseRawRegisterInput('bin16', '1010'), 10n)
assert.equal(parseRawRegisterInput('hex16', 1234), 1234n)
for (const input of ['', '0x', '-1', '1.2', 'GGGG']) assert.throws(() => parseRawRegisterInput('hex16', input))
assert.throws(() => parseRawRegisterInput('bin16', '102'))
assert.throws(() => encodeRegister('hex64', Number.MAX_SAFE_INTEGER + 1))
console.log('RAW WRITE OK: hexadecimal/binary input, exact 64-bit values, byte order and range validation')
