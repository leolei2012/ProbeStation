import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { RealtimeFallbackRead } from '../apps/web/src/realtime-fallback.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'

// Executes the actual App WebSocket effect and actual JSX with controlled sockets/clocks/events.
// No App import, browser, fetch, network listener, driver, real timer or database.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const find = (node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined => { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const effect = find(source, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && !!node.arguments[0]?.getText(source).includes('const HEARTBEAT_MS')) as ts.CallExpression
const literal = (find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!
assert(!find(literal, ts.isCallExpression)); const messages = new Function(compile('return (' + literal.getText(source) + ')'))()
const view = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceView') as ts.JsxSelfClosingElement
const connected = (view.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'connected') as ts.JsxAttribute).initializer as ts.JsxExpression
const badge = find(source, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'span' && node.openingElement.getText(source).includes("'status-badge'"))!
const dot = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'span' && node.getText(source).includes("'device-dot'"))!
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), compile('return (' + node.getText(source) + ')'))(...Object.values(env))
function fixture() {
  let time = 1800000000000, nextTimer = 1, reads = 0, refreshes = 0
  const state = { latest: {} as Record<string, any>, errors: {} as Record<number, string>, devices: {} as Record<number, boolean>, fallback: {} as Record<number, boolean>, realtime: { status: 'connecting', attempt: 0 } }
  const intervals = new Map<number, () => void>(), timers = new Map<number, () => void>()
  const surface = (extra: object = {}) => { const listeners = new Map<string, () => void>(); return { ...extra, listeners, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string, fn: () => void) => { if (listeners.get(name) === fn) listeners.delete(name) } } }
  const window = surface(), document = surface({ visibilityState: 'visible' }), sockets: Socket[] = []
  class Socket {
    static OPEN = 1
    readyState = 0; onopen?: () => void; onmessage?: (event: any) => void; onerror?: () => void; onclose?: () => void
    constructor(readonly url: string) { assert.equal(url, 'ws://synthetic.invalid/ws'); sockets.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
    close() { this.readyState = 3; this.onclose?.() }
    send() { throw new Error('No heartbeat/send is needed by these synthetic scenarios') }
  }
  const assign = (name: keyof typeof state) => (value: any) => { (state as any)[name] = typeof value === 'function' ? value((state as any)[name]) : value }
  const reference: { current?: RealtimeFallbackRead<any> } = {}
  const env = { WebSocket: Socket, location: { protocol: 'http:', host: 'synthetic.invalid' }, window, document, Date: class extends Date { static now() { return time } }, setInterval(fn: () => void) { const id = nextTimer++; intervals.set(id, fn); return id }, clearInterval(id: number) { intervals.delete(id) }, setTimeout(fn: () => void) { const id = nextTimer++; timers.set(id, fn); return id }, clearTimeout(id: number) { timers.delete(id) }, selectedIdRef: { current: 1 }, fallbackReadRef: reference, RealtimeFallbackRead, sourceKey, request: async () => { reads++; throw new Error('No read expected') }, refreshDevices() { refreshes++ }, refreshRegisters() { refreshes++ }, setLatest: assign('latest'), setGroupErrors: assign('errors'), setDeviceConnected: assign('devices'), setFallbackStatus: assign('fallback'), setRealtime: assign('realtime') }
  const dispose = evaluate(effect.arguments[0], env)()
  const connection = () => evaluate(connected.expression!, { realtime: state.realtime, deviceConnected: state.devices, selected: { id: 1 } })
  const render = (english = false, fields = {}, groups = [{ isActive: 1 }]) => {
    const t = (key: string) => messages[english ? 'en' : 'zh'][key] ?? key
    return renderToStaticMarkup(evaluate(badge, { React, t, device: { id: 1, mode: 'master', isActive: 1, ...fields }, groups, connected: connection() }))
  }
  const indicator = (id = 1, english = false) => evaluate(dot, { React, d: { id }, deviceConnected: state.devices, realtime: state.realtime, t: (key: string) => messages[english ? 'en' : 'zh'][key] ?? key }) as React.ReactElement<any>
  return { state, sockets, connection, render, indicator, advance(ms: number) { time += ms }, watchdog() { const tick = [...intervals.values()].find(fn => fn.toString().includes('lastMessageAt')); assert(tick); tick() }, reconnect() { const callback = timers.values().next().value; assert(callback); timers.clear(); callback() }, get reads() { return reads }, close() { dispose(); assert.equal(intervals.size, 0); assert.equal(timers.size, 0); assert.equal(window.listeners.size, 0); assert.equal(document.listeners.size, 0); assert.equal(reference.current, undefined); assert.equal(reads, 0); assert.equal(refreshes, 0) } }
}
const failures: unknown[] = []; let passed = 0
async function check(name: string, test: (f: ReturnType<typeof fixture>) => void) { const f = fixture(); try { test(f); passed++; console.log('DEVICE CONNECTION VIEW OK:', name) } catch (error) { failures.push(error); console.error('DEVICE CONNECTION VIEW FAILED:', name, error) } finally { f.close() } }
await check('lost page channel cannot retain a green sampling badge or sidebar dot', f => {
  const socket = f.sockets[0]; socket.open(); socket.message({ type: 'device/status', states: [{ objectId: 1, connected: true }] })
  assert.equal(f.connection(), true); assert(f.render().includes('采集中')); assert(f.indicator().props.className.includes(' on'))
  socket.close(); assert.equal(f.state.realtime.status, 'reconnecting'); assert.equal(f.connection(), undefined)
  for (const english of [false, true]) { const html = f.render(english); assert(html.includes(english ? 'Device connection unverified' : '设备连接状态未核实')); assert(!html.includes('status-badge on')); assert(!f.indicator(1, english).props.className.includes(' on')); assert.equal(f.indicator(1, english).props.title, english ? 'Device connection unverified' : '设备连接状态未核实') }
})
await check('new page connection waits for its own report; false and true recover independently', f => {
  const first = f.sockets[0]; first.open(); first.message({ type: 'device/status', objectId: 1, connected: true }); first.close(); f.reconnect()
  const next = f.sockets[1]; next.open(); assert.equal(f.state.realtime.status, 'connected'); assert.equal(f.connection(), undefined, 'socket open alone is not a device report')
  first.message({ type: 'device/status', objectId: 1, connected: true }); assert.equal(f.connection(), undefined, 'old socket cannot confirm the new channel')
  next.message({ type: 'device/status', objectId: 1, connected: false }); assert.equal(f.connection(), false); assert(f.render(true).includes('Awaiting communication'))
  next.message({ type: 'device/status', objectId: 1, connected: true }); assert.equal(f.connection(), true); assert(f.render(true).includes('Sampling'))
  first.message({ type: 'device/status', objectId: 1, connected: false }); assert.equal(f.connection(), true, 'late old socket cannot replace the recovered device report')
})
await check('stale page channel is unverified without inventing a hardware disconnect', f => {
  const socket = f.sockets[0]; socket.open(); socket.message({ type: 'device/status', objectId: 1, connected: true }); f.advance(31000); f.watchdog()
  assert.equal(f.state.realtime.status, 'stale'); assert.equal(f.connection(), undefined); assert(!f.indicator().props.className.includes(' on')); assert.equal(f.state.devices[1], true, 'retain the last report rather than manufacture a device false event')
})
await check('new snapshot clears old-device reports; a missing device is not coerced to false', f => {
  const socket = f.sockets[0]; socket.open(); socket.message({ type: 'device/status', states: [{ objectId: 1, connected: true }, { objectId: 2, connected: false }] }); socket.close(); f.reconnect(); f.sockets[1].open()
  assert.equal(f.state.devices[2], undefined); f.sockets[1].message({ type: 'device/status', states: [{ objectId: 1, connected: true }] })
  assert.equal(f.connection(), true); assert.equal(f.state.devices[2], undefined); assert(!f.indicator(2).props.className.includes(' on'))
})
await check('known paused/no-active-groups and slave modes retain their separate meanings', f => {
  for (const english of [false, true]) {
    assert(f.render(english, { isActive: 0 }).includes(english ? 'Sampling paused' : '采集已暂停'))
    assert(f.render(english, {}, [{ isActive: 0 }]).includes(english ? 'No enabled groups' : '没有启用的分组'))
    assert(f.render(english, { mode: 'slave', isActive: 0 }).includes('从站已停止'))
    assert(f.render(english, { mode: 'slave' }).includes(english ? 'Device connection unverified' : '设备连接状态未核实'))
  }
})
if (failures.length) throw new AggregateError(failures, `${failures.length} device connection view cases failed; ${passed} passed`)
console.log(`DEVICE CONNECTION VIEW TEST OK: ${passed} actual effect/JSX cases with mock sockets/clocks, no browser, network, hardware or data writes`)
