import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { parseRegisterWriteValue, registerWritePayloadValue } from '../packages/core/src/register-write-value.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerWidth, isHexType, isBinType } from '../packages/core/src/codec.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

// The target is always a spy. Never import/start the poller, connect a device or open a real config.
const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify()
const writes: unknown[][] = [], logs: unknown[][] = []
let failWrite = false
const target = { write: async (...args: unknown[]) => { writes.push(args); if (failWrite) throw new Error('synthetic target failure') } }
cfg.log = ((...args: unknown[]) => { logs.push(args) }) as any
registerRegisterWrite(app, cfg, target)
try {
  const device = cfg.createObject('Mock input boundary', '', 502), group = cfg.createGroup(device.id, 'Mock', 3, 10, 4, 'read', 7)
  const point = cfg.createRegister(group.id, device.id, 'Value', 3, 10, 'uint16')
  const send = (payload: unknown) => app.inject({ method: 'POST', url: '/api/registers/' + point.id + '/write', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
  for (const type of ['uint16', 'int32-LE', 'float32', 'float64', 'q15', 'uint64', 'int64-LE', 'hex64-LE', 'bin16']) {
    cfg.updateRegister(point.id, { dataType: type })
    for (const value of [null, '', ' \t\n ', true, false, [], [0], {}, 'bad-number', 'NaN', 'Infinity', '-Infinity']) {
      const before = [writes.length, logs.length], response = await send({ value })
      assert.equal(response.statusCode, 400, type + ': ' + JSON.stringify(value)); assert(response.json().error)
      assert.deepEqual([writes.length, logs.length], before, 'invalid input must reach neither mock write nor success logging')
    }
    for (const body of [{}, [], null, '1', 1, false]) {
      const before = writes.length; assert.equal((await send(body)).statusCode, 400); assert.equal(writes.length, before)
    }
  }
  const cases: Array<[string, string | number, number | bigint]> = [
    ['uint16', 0, 0], ['int16', '-12', -12], ['uint16-LE', ' 42 ', 42], ['int32', '0x12345678', 0x12345678], ['uint32-LE', 4294967295, 4294967295],
    ['float16', 1.5, 1.5], ['float32-LE', '1.5e2', 150], ['float64', 3.14159265358979, 3.14159265358979], ['q15', -0.5, -0.5], ['q31-LE', 0.25, 0.25],
    ['uint64', '18446744073709551615', 18446744073709551615n], ['int64-LE', '-9223372036854775808', -9223372036854775808n], ['int64', Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
    ['hex16', '0xABCD', 0xabcdn], ['hex32-LE', '0x1234 0x5678', 0x12345678n], ['hex64', '0xffffffffffffffff', 18446744073709551615n], ['bin16-LE', '0b1010', 10n], ['bin64-LE', '0b' + '1'.repeat(64), 18446744073709551615n],
    // Preserve existing numeric codec behavior; this change is not a new rounding/range policy.
    ['uint16', 1.6, 1.6], ['q15', 2, 2],
  ]
  for (const [type, input, legacyValue] of cases) {
    cfg.updateRegister(point.id, { dataType: type })
    for (const value of [input, JSON.parse(JSON.stringify(registerWritePayloadValue(type, input)))]) {
      const before = writes.length, response = await send({ value, method: 'single' })
      assert.equal(response.statusCode, 200, type + ': ' + response.body)
      const expected = encodeRegister(type, legacyValue), actual = response.json()
      assert.deepEqual(actual.words, expected); assert.equal(writes.length, before + 1)
      assert.deepEqual(writes.at(-1), [device.id, 10, expected, expected.length > 1 ? 'multiple' : 'single', 7, 'holding-register'])
      assert.equal(actual.value, String(legacyValue)); assert.equal(actual.dataType, type)
    }
  }
  cfg.updateRegister(point.id, { dataType: 'uint64' })
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, 1.5]) {
    const before = writes.length; assert.equal((await send({ value })).statusCode, 400); assert.equal(writes.length, before)
  }
  cfg.updateRegister(point.id, { functionCode: 1, dataType: 'uint16' })
  const coil = await send({ value: 1 }); assert.equal(coil.statusCode, 200); assert.equal(writes.at(-1)?.at(-1), 'coil'); assert.deepEqual(coil.json().words, [1])
  const beforeFailure = [writes.length, logs.length]; failWrite = true
  assert.equal((await send({ value: 0 })).statusCode, 500); assert.equal(writes.length, beforeFailure[0] + 1); assert.equal(logs.length, beforeFailure[1], 'target failure does not log a successful write or auto-retry')
  failWrite = false; cfg.updateRegister(point.id, { functionCode: 3, dataType: 'uint16' })
  const oldSlave = cfg.getGroup(group.id)!.slaveId; cfg.updateGroup(group.id, { slaveId: 9 })
  const oldClientRequest = await send({ value: 42, method: 'single' })
  assert.equal(oldClientRequest.statusCode, 200); assert.equal(oldSlave, 7); assert.equal(writes.at(-1)?.[4], 9)
  console.log('REGISTER WRITE SOURCE GAP: an ID/value-only request is admitted against changed slave 7->9; spy target only. Known unprotected path, not a safety pass.')
} finally { await app.close(); (cfg as any).db.close() }

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
console.log('REGISTER WRITE VALUE OK: null/empty/missing/coercion/nonfinite rejection before spy writes/logs, safe 64-bit numeric input and exact strings, JSON-safe UI values, legacy 16/32/64 BE/LE/raw/q/float encoding, methods/slave/area and target failure; Fastify.inject + memory config only, no poller/hardware/listeners/model or real data')

for (const english of [false, true]) for (const local of [false, true]) {
  let calls = 0, reject!: (error: Error) => void
  const pending = new Promise<void>((_resolve, fail) => { reject = fail })
  const props = { t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, reg: { id: 1, alias: 'Mock', startAddress: 0, dataType: 'uint16', functionCode: 3 }, deviceName: 'Mock only', currentValue: '0', local, onClose() {}, onSaved() { throw Error('unexpected save') } }
  const driver = hookDriver('App.tsx', 'WriteModal', { registerWidth, isHexType, isBinType, registerWritePayloadValue, api: { async post() { calls++; return pending } } }, props)
  const warning = english ? /Source is not locked\. Changes may redirect this write\./ : /来源未锁定；配置变化可能使写入转向新目标。/
  try {
    assert.match(renderToStaticMarkup(driver.tree), warning, 'both remote and local dialogs must expose the unresolved source boundary')
    assert.equal(calls, 0, 'warning display never submits or preflights')
    driver.one('input').props.onChange({ target: { value: '42' } }); driver.render()
    driver.one('button', p => p.className === 'btn primary').props.onClick(); driver.render()
    assert.equal(calls, 1); assert.match(renderToStaticMarkup(driver.tree), warning)
    reject(Error('synthetic response lost')); await new Promise<void>(done => setImmediate(done)); driver.render()
    assert.equal(driver.one('input').props.value, '42'); assert.equal(calls, 1)
    assert.match(renderToStaticMarkup(driver.tree), warning)
  } finally { reject(Error('cleanup')); driver.dispose() }
}
console.log('WRITE SOURCE WARNING OK: bilingual remote/local dialogs retain warning and input through pending and lost response; spy only, no auto-write or preflight, not an atomic source guard')
