import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { SerialPort } from 'serialport'
import { listSystemSerialPorts, sanitizeSerialPorts } from '../packages/modbus/src/serial-ports.ts'
import { registerSerialPorts } from '../packages/api/src/serial-ports.ts'
import { SerialPortLoader, serialPortChoices, type SerialPortList, type SerialPortState } from '../apps/web/src/serial-ports.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SerialPortPickerView } from '../apps/web/src/SerialPortPicker.tsx'

const ports = [{ path: 'COM14', manufacturer: 'Vendor', friendlyName: 'USB Serial Device', serialNumber: 'excluded', pnpId: 'excluded' }, { path: 'COM2' }, { path: 'COM14' }, { path: '/dev/ttyUSB0' }]
const sanitized = sanitizeSerialPorts(ports)
assert.equal(sanitized.length, 3)
assert.deepEqual(sanitized.find(p => p.path === 'COM14'), { path: 'COM14', manufacturer: 'Vendor', description: 'USB Serial Device' })
assert(sanitized.findIndex(p => p.path === 'COM2') < sanitized.findIndex(p => p.path === 'COM14'))
assert.deepEqual(sanitizeSerialPorts([{ path: '' }, { path: ' ' }]), [])

// Native enumeration is replaced before invocation. Any attempt to open is an immediate failure.
const originalList = SerialPort.list, originalOpen = SerialPort.binding.open
let opens = 0, enumerations = 0
SerialPort.binding.open = async () => { opens++; throw new Error('Test forbids serial opening') }
SerialPort.list = async () => { enumerations++; return ports as any }
try {
  assert.deepEqual(await listSystemSerialPorts(), sanitized)
  assert.equal(enumerations, 1); assert.equal(opens, 0)
} finally { SerialPort.list = originalList; SerialPort.binding.open = originalOpen }

const app = Fastify()
let fail = false, empty = false, calls = 0
registerSerialPorts(app, async () => { calls++; if (fail) throw new Error('native secret detail must not escape'); return empty ? [] : sanitized }, 'mock')
try {
  const response = await app.inject('/api/serial-ports')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ports: sanitized, source: 'mock', location: 'backend', enumerationOnly: true })
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal((await app.inject({ method: 'POST', url: '/api/serial-ports' })).statusCode, 404)
  empty = true
  assert.deepEqual((await app.inject('/api/serial-ports')).json().ports, [])
  empty = false; fail = true
  const rejected = await app.inject('/api/serial-ports')
  assert.equal(rejected.statusCode, 503); assert(!rejected.body.includes('secret detail'))
  fail = false
  assert.equal((await app.inject('/api/serial-ports')).json().ports.length, 3)
  assert.equal(calls, 4, 'each refresh enumerates again; no configured-device cache')
} finally { await app.close() }

const result: SerialPortList = { ports: sanitized, source: 'system', location: 'backend', enumerationOnly: true }
const states: SerialPortState[] = [], loader = new SerialPortLoader(state => states.push(state))
await loader.refresh(async () => result)
assert.equal(states[0].status, 'loading'); assert.equal(loader.state.status, 'ready')
let entered = 'COM14'
let choices = serialPortChoices(loader.state.ports, entered)
assert.equal(choices.find(p => p.value === entered)!.discovered, true)
assert.match(choices.find(p => p.value === entered)!.label, /COM14.*USB Serial Device.*Vendor/)
entered = 'COM99'
await loader.refresh(async () => ({ ...result, ports: [] }))
choices = serialPortChoices(loader.state.ports, entered)
assert.deepEqual(choices, [{ value: 'COM99', label: 'COM99', discovered: false }])
await loader.refresh(async () => { throw new Error('offline') })
assert.equal(loader.state.status, 'error'); assert.equal(entered, 'COM99')
await loader.refresh(async () => result)
assert.equal(loader.state.error, null); assert.equal(entered, 'COM99')
const markup = (state: SerialPortState) => renderToStaticMarkup(createElement(SerialPortPickerView, { value: entered, onChange: value => { entered = value }, state, refresh: () => {} }))
const populated = markup(loader.state)
assert.match(populated, /value="COM14"/)
assert.match(populated, /value="COM99" selected=""/)
assert.match(populated, /input[^>]+value="COM99"/)
assert.match(populated, /后端/)
assert.match(markup({ ...loader.state, source: 'mock' }), /模拟端口清单，不是实机端口/)
assert.match(markup({ ...loader.state, status: 'loading' }), /正在读取串口清单/)
assert.match(markup({ ...loader.state, status: 'ready', ports: [] }), /系统未发现串口/)
assert.match(markup({ ...loader.state, status: 'error' }), /读取失败/)
assert.equal(entered, 'COM99', 'refresh/render never invokes the controlled path setter')

let resolveOld!: (value: SerialPortList) => void
const old = loader.refresh(() => new Promise(resolve => { resolveOld = resolve }))
await loader.refresh(async () => ({ ...result, ports: [{ path: 'COM7' }] }))
resolveOld(result); await old
assert.deepEqual(loader.state.ports, [{ path: 'COM7' }], 'late responses cannot overwrite a newer refresh')
let resolveClosed!: (value: SerialPortList) => void
const closing = loader.refresh(() => new Promise(resolve => { resolveClosed = resolve }))
const beforeClose = states.length
loader.cancel(); resolveClosed(result); await closing
assert.equal(states.length, beforeClose, 'unmounted picker receives no late update')
await loader.refresh(async () => ({ ...result, ports: [{ path: 'COM8' }] }))
assert.equal(loader.state.ports[0].path, 'COM8', 'refresh works after effect cleanup/remount')
assert.equal(opens, 0)
console.log('SERIAL PORTS OK: system-list adapter (mocked native list, no opens), metadata whitelist, multi/empty/failure/retry, path preservation, exact option mapping, stale responses and SSR states')
