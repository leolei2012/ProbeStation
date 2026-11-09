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

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let found: ts.Node | undefined; ts.forEachChild(node, child => { found ??= find(child, predicate) }); return found }
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
const modalNode = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'WriteModal')!
for (const english of [false, true]) for (const local of [false, true]) for (const entry of ['onClick', 'onDoubleClick']) {
  const memory = new ConfigStore({ dbPath: ':memory:' }), apiApp = Fastify(), emitted: unknown[][] = []
  const device = memory.createObject('Mock only', '0.0.0.0', 1502, local ? 'slave' : 'master'), group = memory.createGroup(device.id, 'Mock only', 3, 0, 4, 'read', 7), reg = memory.createRegister(group.id, device.id, 'Mock only', 3, 0, 'uint16')
  registerRegisterWrite(apiApp, memory, { async write(...args: unknown[]) { emitted.push(args) } })
  let calls = 0, saved = 0, writeReg: typeof reg | null = null
  const t = (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key
  const opening = find(source, node => ts.isJsxAttribute(node) && node.name.getText(source) === entry && node.initializer?.getText(source).includes('setWriteReg(r)') === true) as ts.JsxAttribute
  const env = { React, t, device, views: new Map([[reg.id, { value: '0' }]]), writable: true, r: reg, setWriteReg(value: typeof reg | null) { writeReg = value }, operation: { setNotice() { saved++ } }, WriteModal: () => null }
  evaluate((opening.initializer as ts.JsxExpression).expression!, env)(); assert.equal(writeReg, reg)
  const element = evaluate(modalNode, { ...env, writeReg }) as React.ReactElement<Record<string, unknown>>, props = element.props
  const driver = hookDriver('App.tsx', 'WriteModal', { registerWidth, isHexType, isBinType, registerWritePayloadValue, api: { async post(url: string, payload: unknown) { calls++; const response = await apiApp.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }); if (response.statusCode >= 400) throw Error(response.body); return response.json() } } }, props)
  try {
    const warning = english ? /Direct writes blocked: source binding unavailable/ : /直接写入已阻止：缺少来源绑定/
    assert.match(renderToStaticMarkup(driver.tree), warning)
    const send = driver.one('button', p => p.className === 'btn primary')
    assert.equal(send.props.disabled, true, 'unbound UI must never offer an enabled sender')
    assert.equal(send.props.onClick, undefined, 'blocking must remove the sender, not just its visual state')
    for (const value of ['0', '42', '18446744073709551615', 'bad-number']) {
      driver.one('input').props.onChange({ target: { value } }); driver.render()
      memory.updateGroup(group.id, { slaveId: 9 }); memory.updateObject(device.id, { mode: 'master', ip: 'changed.mock.invalid' })
      driver.render({ ...props, deviceName: 'Changed source', local: false, currentValue: '99' })
      assert.equal(driver.one('input').props.value, value); assert.match(renderToStaticMarkup(driver.tree), warning)
      assert.equal(driver.one('button', p => p.className === 'btn primary').props.onClick, undefined)
    }
    assert.equal(calls, 0); assert.equal(emitted.length, 0); assert.equal(saved, 0)
    // The real legacy route is still operational against a spy, independently of UI blocking.
    const legacy = await apiApp.inject({ method: 'POST', url: '/api/registers/' + reg.id + '/write', payload: { value: 42 } })
    assert.equal(legacy.statusCode, 200); assert.equal(emitted.length, 1); assert.equal(emitted[0][4], 9); assert.equal(calls, 0)
    driver.one('button', p => p.className === 'btn').props.onClick(); assert.equal(writeReg, null)
  } finally { driver.dispose(); await apiApp.close(); await memory.close() }
}
console.log('WRITE UI BLOCK OK: actual click/double-click entry and modal props, bilingual remote/local source changes, zero UI API/spy writes, input preservation and close; real legacy route unchanged. Risk mitigation only; old APIs and old loaded clients remain unguarded.')
