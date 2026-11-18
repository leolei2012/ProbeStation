import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { parseRegisterWriteValue, registerWritePayloadValue } from '../packages/core/src/register-write-value.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerWidth, isHexType, isBinType } from '../packages/core/src/codec.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { readFileSync } from 'node:fs'
import React from 'react'
import ts from 'typescript'

// Value parsing remains compatible; the legacy unbound endpoint stays disabled.
  const cases: Array<[string, string | number, number | bigint]> = [
    ['uint16', 0, 0], ['int16', '-12', -12], ['uint16-LE', ' 42 ', 42], ['int32', '0x12345678', 0x12345678], ['uint32-LE', 4294967295, 4294967295],
    ['float16', 1.5, 1.5], ['float32-LE', '1.5e2', 150], ['float64', 3.14159265358979, 3.14159265358979], ['q15', -0.5, -0.5], ['q31-LE', 0.25, 0.25],
    ['uint64', '18446744073709551615', 18446744073709551615n], ['int64-LE', '-9223372036854775808', -9223372036854775808n], ['int64', Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
    ['hex16', '0xABCD', 0xabcdn], ['hex32-LE', '0x1234 0x5678', 0x12345678n], ['hex64', '0xffffffffffffffff', 18446744073709551615n], ['bin16-LE', '0b1010', 10n], ['bin64-LE', '0b' + '1'.repeat(64), 18446744073709551615n],
    // Preserve existing numeric codec behavior; this change is not a new rounding/range policy.
    ['uint16', 1.6, 1.6], ['q15', 2, 2],
  ]

for (const [type, input, legacyValue] of cases) assert.deepEqual(encodeRegister(type, parseRegisterWriteValue(type, registerWritePayloadValue(type, input))), encodeRegister(type, legacyValue))
const app = Fastify(); let effects = 0
registerRegisterWrite(app, { getRegister() { throw Error('must not read configuration') }, getGroup() { throw Error('must not read configuration') }, log() { effects++ } }, { async write() { effects++ } })
try { for (const payload of [{value:42}, {value:null}, {}, {value:'18446744073709551615'}]) { const response = await app.inject({method:'POST',url:'/api/registers/1/write',payload}); assert.equal(response.statusCode,503); assert.equal(response.json().code,'DEVICE_WRITE_BLOCKED'); assert.equal(response.json().retryable,false) }; assert.equal(effects,0) } finally { await app.close() }

for (const type of ['int16', 'float32', 'uint64', 'hex32', 'bin64']) {
  for (const value of [undefined, null, '', ' ', true, false, [], [1], {}, NaN, Infinity, -Infinity]) assert.throws(() => parseRegisterWriteValue(type, value))
}
let coercions = 0
assert.throws(() => parseRegisterWriteValue('int16', { valueOf() { coercions++; return 1 } })); assert.equal(coercions, 0, 'objects must be rejected without invoking coercion')
assert.equal(registerWritePayloadValue('int64', ' 9007199254740993 '), '9007199254740993')
assert.equal(registerWritePayloadValue('hex64', 'FFFFFFFFFFFFFFFF'), '0xffffffffffffffff')
assert.equal(registerWritePayloadValue('bin64', '1111'), '0b1111')
assert.equal(registerWritePayloadValue('hex32', 'FFFFFFFF'), 4294967295)
assert.equal(parseRegisterWriteValue('uint64', 18446744073709551615n), 18446744073709551615n)
assert.throws(() => parseRegisterWriteValue('uint64', Number.MAX_SAFE_INTEGER + 1), /安全整数/)
console.log('REGISTER WRITE VALUE OK: null/empty/missing/coercion/nonfinite rejection before spy writes/logs, safe 64-bit numeric input and exact strings, JSON-safe UI values, pure 16/32/64 BE/LE/raw/q/float encoding and default HTTP refusal; Fastify.inject + memory config only, no poller/hardware/listeners/model or real data')

console.log('REGISTER WRITE VALUE OK: numeric/radix/64-bit input semantics; legacy unbound endpoint remains closed. Bound UI workflow is covered by test-bound-register-write-ui.ts.')
