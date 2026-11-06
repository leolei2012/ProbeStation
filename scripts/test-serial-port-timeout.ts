import assert from 'node:assert/strict'
import { SerialPortLoader, serialPortChoices, SERIAL_PORT_TIMEOUT_MS, type SerialPortList, type SerialPortState } from '../apps/web/src/serial-ports.ts'
import { SerialPortPickerView } from '../apps/web/src/SerialPortPicker.tsx'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The provider deliberately ignores abort. No serial package, API or native enumeration.
const loader = new SerialPortLoader(() => {}, { timeoutMs: 5 })
const pending = loader.refresh(() => new Promise(() => {}))
const settled = await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
loader.cancel()
assert.equal(settled, true, 'a hung serial-list provider must release the refresh control')
assert.equal(loader.state.status, 'error')
assert.equal(loader.state.error, 'enumeration-timeout')
assert.equal(SERIAL_PORT_TIMEOUT_MS, 10_000)
const result: SerialPortList = { ports: [{ path: 'COM14', description: '模拟端口' }], source: 'mock', location: 'backend', enumerationOnly: true }
const states: SerialPortState[] = [], current = new SerialPortLoader(state => states.push(state), { timeoutMs: 5 })
await current.refresh(async () => result)
let late!: (value: SerialPortList) => void, timedSignal!: AbortSignal
await current.refresh(signal => { timedSignal = signal; return new Promise(resolve => { late = resolve }) })
assert.equal(timedSignal.aborted, true, 'timeout also aborts the fetch/body reader')
assert.equal(current.state.error, 'enumeration-timeout')
assert.deepEqual(current.state.ports, result.ports); assert.equal(current.state.source, 'mock', 'timeout retains the previous list with its original provenance')
const entered = 'COM99', choices = serialPortChoices(current.state.ports, entered)
assert.equal(choices[0].value, entered); assert.equal(choices[0].discovered, false)
let changes = 0
for (const english of [false, true]) {
  const html = renderToStaticMarkup(createElement(SerialPortPickerView, { value: entered, onChange() { changes++ }, state: current.state, refresh() {}, english }))
  assert.match(html, /role="alert"/); assert.match(html, english ? /10 seconds/ : /10 秒/)
  assert.match(html, /value="COM99"/); assert.match(html, /value="COM14"/)
  assert.doesNotMatch(html, /<button[^>]*disabled/, 'refresh is available again after the deadline')
  assert.match(html, english ? /Mock list/ : /模拟端口清单/)
}
assert.equal(changes, 0, 'timeout rendering cannot change a controlled manual path')
await current.refresh(async () => ({ ...result, ports: [{ path: 'COM7' }] }))
late(result); await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(current.state.status, 'ready'); assert.equal(current.state.error, null)
assert.deepEqual(current.state.ports, [{ path: 'COM7' }], 'a timed-out provider cannot overwrite retry results')
await current.refresh(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
assert.equal(current.state.error, 'enumeration-timeout', 'abort-aware providers keep the deadline reason instead of becoming a generic failure')
await current.refresh(async () => { throw new Error('private provider detail') })
assert.equal(current.state.error, 'enumeration-failed')
assert.ok(!JSON.stringify(current.state).includes('private provider detail'))

let started!: (value: AbortSignal) => void
const hasStarted = new Promise<AbortSignal>(resolve => { started = resolve })
const closing = current.refresh(signal => { started(signal); return new Promise(() => {}) })
const closedSignal = await hasStarted, beforeClose = states.length
current.cancel(); await closing
assert.equal(closedSignal.aborted, true); assert.equal(states.length, beforeClose, 'cleanup settles a non-cooperative provider without updating an unmounted picker')
let calls = 0
const preCancelled = current.refresh(async () => { calls++; return result })
current.cancel(); await preCancelled
assert.equal(calls, 0, 'cleanup before the provider microtask avoids unnecessary enumeration')
await current.refresh(async () => ({ ...result, ports: [] }))
assert.equal(current.state.status, 'ready'); assert.deepEqual(current.state.ports, [])
assert.equal(current.state.error, null, 'empty-list retry recovers after timeout/failure/unmount')
console.log('SERIAL PORT TIMEOUT OK: hung/abort-aware providers, bounded settlement, abort/late result/retry/cleanup, stale list and manual-path preservation, mock provenance and bilingual SSR; no serial package or native calls')
