import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { registerWriteSource, type GuardedWriteResult } from '../packages/core/src/guarded-register-write.ts'

const memory = new Map<string, string>(), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } })
const source = registerWriteSource({ id: 1, name: 'Compressor', mode: 'master', transport: 'tcp', ip: '192.0.2.10', port: 502, serialPath: null, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none' },
  { id: 3, slaveId: 7, functionCode: 3, startAddress: 0x1000, quantity: 1 },
  { id: 9, objectId: 1, groupId: 3, startAddress: 0x1000, dataType: 'uint16', alias: 'Switch', factor: 1, offset: 0 })
const makeOperation = (value = '1'): GuardedWriteResult => ({ version: 1, id: '12345678-1234-1234-1234-123456789abc', state: 'prepared', message: '', plan: { version: 1, id: '12345678-1234-1234-1234-123456789abc', channel: 'tcp:192.0.2.10:502', scope: 'mock', revision: 'mock', source, value, words: [Number(value)], functionCode: 6, expiresAt: Date.now() + 120000, timeoutMs: 100 } })
const settle = async (driver: ReturnType<typeof hookDriver>) => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); driver.render() } }
const button = (driver: ReturnType<typeof hookDriver>, label: string) => driver.one('button', p => p.children === label)
try {
  for (const english of [false, true]) {
    memory.clear(); let writes = 0, operation = makeOperation(), loseResponse = false, closed = 0
    const calls: any[] = []
    const request = async (path: string, body?: any) => {
      calls.push({ path, body })
      if (path.endsWith('/prepare')) { assert.deepEqual(body.source, source); return operation = makeOperation(body.value) }
      if (path.endsWith('/execute')) { writes++; assert.deepEqual(body, { version: 1 }); if (loseResponse) { operation.state = 'unknown'; throw Error('synthetic lost response') }; operation.state = 'acknowledged'; operation.message = 'Matching Modbus receipt'; return operation }
      if (path.endsWith('/review-unknown')) { assert.deepEqual(body, { confirmedOnSite: true }); operation.state = 'reviewed-unknown'; return operation }
      assert.equal(body, undefined, 'result lookup is read-only'); return operation
    }
    const props = { source, english, currentValue: '0', onClose() { closed++ } }
    const driver = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { writeRequest: request }, props)
    try {
      await settle(driver)
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '1' } }); driver.render()
      const prepare = english ? 'Prepare write' : '准备写入', confirm = english ? 'Confirm write' : '确认写入'
      assert.equal(button(driver, prepare).props.disabled, false)
      button(driver, prepare).props.onClick(); await settle(driver)
      assert.equal(writes, 0); assert(memory.size === 1)
      const markup = renderToStaticMarkup(driver.tree); assert(markup.includes('0x1000')); assert(markup.includes('FC6')); assert(markup.includes('0x0001'))
      const send = button(driver, confirm); assert.equal(send.props.disabled, false)
      send.props.onClick(); send.props.onClick(); await settle(driver)
      assert.equal(writes, 1, 'double click cannot replay command')
      assert(renderToStaticMarkup(driver.tree).includes('Matching Modbus receipt'))
      button(driver, english ? 'New plan' : '准备新指令').props.onClick(); driver.render()
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '0' } }); driver.render()
      button(driver, prepare).props.onClick(); await settle(driver)
      loseResponse = true; button(driver, confirm).props.onClick(); await settle(driver)
      assert.equal(writes, 2); assert(renderToStaticMarkup(driver.tree).includes('synthetic lost response'))
      const checks = calls.length
      button(driver, english ? 'Check result' : '查询结果').props.onClick(); await settle(driver)
      assert.equal(calls.length, checks + 1); assert.equal(writes, 2, 'unknown response never enables automatic retry')
      assert.equal(button(driver, english ? 'Record review' : '记录现场核实').props.disabled, true)
      driver.one('input', p => p.type === 'checkbox').props.onChange({ target: { checked: true } }); driver.render()
      button(driver, english ? 'Record review' : '记录现场核实').props.onClick(); await settle(driver)
      assert.equal(writes, 2)
      button(driver, english ? 'New plan' : '准备新指令').props.onClick(); driver.render()
      button(driver, prepare).props.onClick(); await settle(driver)
      driver.render({ ...props, source: { ...source, group: { ...source.group, slaveId: 9 } } })
      assert.equal(button(driver, confirm).props.disabled, true, 'source change disables the reviewed plan')
      button(driver, english ? 'Close' : '关闭').props.onClick(); assert.equal(closed, 1)
    } finally { driver.dispose() }
    const before = writes
    const restored = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { writeRequest: request }, props)
    try { await settle(restored); assert.equal(writes, before); assert(calls.at(-1).body === undefined, 'reopen queries the saved ID without submission') } finally { restored.dispose() }
  }
  console.log('BOUND WRITE UI OK: bilingual raw 0/1, prepare/source/FC/word review, one confirmation, double click suppression, lost receipt read-only lookup, onsite review, changed source refusal and reload recovery')
} finally { if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else delete (globalThis as any).sessionStorage }
