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

// Pure codec semantics remain covered; HTTP sending is intentionally disabled.
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
    assert.equal(props.onSaved, undefined, 'blocked modal must not retain a late success confirmation callback')
    const warning = english ? /Direct writes blocked: source binding unavailable/ : /直接写入已阻止：缺少来源绑定/
    assert.match(renderToStaticMarkup(driver.tree), warning)
    const send = driver.one('button', p => p.className === 'btn primary')
    assert.equal(send.props.disabled, true, 'unbound UI must never offer an enabled sender')
    assert.equal(send.props.onClick, undefined, 'blocking must remove the sender, not just its visual state')
    assert.equal(send.props.type, 'button')
    const reason = driver.one('p', p => p.role === 'status'), input = driver.one('input'), label = driver.one('label'), dialog = driver.one('div', p => p.role === 'dialog')
    assert(reason.props.id && input.props.id); assert.equal(label.props.htmlFor, input.props.id)
    assert.equal(input.props['aria-describedby'], reason.props.id); assert.equal(send.props['aria-describedby'], reason.props.id)
    assert.equal(dialog.props['aria-describedby'], reason.props.id); assert.equal(dialog.props['aria-labelledby'], driver.one('h3').props.id)
    const oldOpening = evaluate((opening.initializer as ts.JsxExpression).expression!, env)
    for (const key of ['Enter', ' ', 'Escape']) for (const control of [input, send, dialog]) {
      for (const handler of ['onKeyDown', 'onKeyPress', 'onKeyUp', 'onSubmit']) control.props[handler]?.({ key, preventDefault() {}, stopPropagation() {} })
    }
    const modalFunction = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'WriteModal')!
    assert(!find(modalFunction, node => ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'form'), 'blocked dialog must not have an implicit submit path')
    assert(!find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'WriteModal' && /api\.post|setTimeout|window\.confirm/.test(node.getText(source))))
    for (const value of ['0', '42', '18446744073709551615', 'bad-number']) {
      driver.one('input').props.onChange({ target: { value } }); driver.render()
      memory.updateGroup(group.id, { slaveId: 9 }); memory.updateObject(device.id, { mode: 'master', ip: 'changed.mock.invalid' })
      driver.render({ ...props, deviceName: 'Changed source', local: false, currentValue: '99' })
      assert.equal(driver.one('input').props.value, value); assert.match(renderToStaticMarkup(driver.tree), warning)
      assert.equal(driver.one('button', p => p.className === 'btn primary').props.onClick, undefined)
      for (let repeat = 0; repeat < 20; repeat++) { oldOpening(); driver.render({ ...props, deviceName: 'Changed source', local: false, currentValue: '99' }) }
      assert.equal(driver.one('input').props.value, value, 'repeat or late entry callbacks must not clear the retained input')
      assert.equal(driver.one('input').props.id, input.props.id); assert.equal(driver.one('p', p => p.role === 'status').props.id, reason.props.id)
    }
    assert.equal(calls, 0); assert.equal(emitted.length, 0); assert.equal(saved, 0)
    assert.equal(driver.one('button', p => p.className === 'btn').props.type, 'button', 'close is not a form submit action')
    // The protected REST route refuses independently of UI blocking.
    const legacy = await apiApp.inject({ method: 'POST', url: '/api/registers/' + reg.id + '/write', payload: { value: 42 } })
    assert.equal(legacy.statusCode, 503); assert.equal(legacy.json().code, 'DEVICE_WRITE_BLOCKED'); assert.equal(emitted.length, 0); assert.equal(calls, 0)
    driver.one('button', p => p.className === 'btn').props.onClick(); assert.equal(writeReg, null)
  } finally { driver.dispose(); await apiApp.close(); await memory.close() }
}
console.log('WRITE UI BLOCK OK: actual click/double-click entry and modal props, bilingual remote/local source changes, zero UI API/spy writes, input preservation and close; current REST route also refuses; older binaries and already-admitted operations remain outside this boundary.')

// A previously admitted legacy request is not cancelled by rendering the new blocked component.
{
  const memory = new ConfigStore({ dbPath: ':memory:' }), apiApp = Fastify()
  const device = memory.createObject('Mock in-flight', 'before.mock.invalid', 502), group = memory.createGroup(device.id, 'Mock', 3, 0, 1, 'read', 7), reg = memory.createRegister(group.id, device.id, 'Mock', 3, 0, 'uint16')
  let entered!: () => void, release!: () => void, uiCalls = 0
  const admitted = new Promise<void>(done => { entered = done }), pendingTarget = new Promise<void>(done => { release = done })
  // Model an already-admitted operation in an older process; the new route has no bypass.
  const pending = Promise.resolve().then(async () => { entered(); await pendingTarget; return { statusCode: 200 } })
  await admitted
  const driver = hookDriver('App.tsx', 'WriteModal', { registerWidth, isHexType, isBinType, api: { post() { uiCalls++; throw Error('new UI must not send') } } }, { t: (key: string) => key === 'cancel' ? 'Cancel' : key, reg, deviceName: device.name, currentValue: '0', onClose() {} })
  try {
    driver.one('input').props.onChange({ target: { value: 'KEEP WHILE LEGACY PENDING' } }); driver.render()
    memory.updateGroup(group.id, { slaveId: 9 }); release()
    assert.equal((await pending).statusCode, 200); driver.render()
    assert.equal(uiCalls, 0); assert.equal(driver.one('input').props.value, 'KEEP WHILE LEGACY PENDING')
    assert.equal(driver.one('button', p => p.className === 'btn primary').props.disabled, true)
    assert.doesNotMatch(renderToStaticMarkup(driver.tree), /class="write-msg ok"/)
  } finally { release(); await pending; driver.dispose(); await apiApp.close(); await memory.close() }
}
console.log('WRITE UI INTERACTION OK: semantic label/reason links, simulated Enter/Space/Escape handlers, repeat/late entry and no success callback; admitted legacy request still completes. No real DOM, keyboard, focus or screen-reader proof.')
