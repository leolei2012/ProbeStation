import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { registerWriteSource, registerWriteSourceMatches, type GuardedWriteResult } from '../packages/core/src/guarded-register-write.ts'

import { registerWidth } from '../packages/core/src/codec.ts'
const scope = { registerWidth, registerWriteSourceMatches, pendingWritesRequest: async () => [] }

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
      if (path.endsWith('/prepare')) { assert.deepEqual(body.source, source); operation = makeOperation(body.value); operation.plan.functionCode = body.method === 'multiple' ? 16 : 6; return operation }
      if (path.endsWith('/execute')) { writes++; assert.deepEqual(body, { version: 1 }); if (loseResponse) { operation.state = 'unknown'; throw Error('synthetic lost response') }; operation.state = 'acknowledged'; operation.message = 'Matching Modbus receipt'; return operation }
      if (path.endsWith('/review-unknown')) { assert.deepEqual(body, { confirmedOnSite: true }); operation.state = 'reviewed-unknown'; return operation }
      assert.equal(body, undefined, 'result lookup is read-only'); return operation
    }
    const props = { source, english, currentValue: '0', onClose() { closed++ } }
    const driver = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { ...scope, writeRequest: request }, props)
    const writeLabel = english ? 'Write' : '写入'
    try {
      await settle(driver)
      assert.equal(button(driver, writeLabel).props.disabled, true)
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '1' } }); driver.render()
      const send = button(driver, writeLabel); assert.equal(send.props.disabled, false)
      send.props.onClick(); send.props.onClick(); await settle(driver)
      assert.equal(writes, 1, 'one click sends once; double click cannot replay the command')
      assert.deepEqual(calls.filter(c => c.body).map(c => c.path.split('/').at(-1)), ['prepare', 'execute'])
      assert.equal(memory.size, 1)
      const markup = renderToStaticMarkup(driver.tree)
      assert(markup.includes('0x1000')); assert(markup.includes(english ? 'Write successful' : '写入成功'))
      assert(!markup.includes('Bound write plan') && !markup.includes('已绑定的写入计划') && !markup.includes(operation.id))
      assert(!markup.includes('Prepare write') && !markup.includes('准备写入') && !markup.includes('Confirm write') && !markup.includes('确认写入'))
      assert.equal(driver.one('input', p => p.type !== 'checkbox').props.disabled, false, 'keep input editable after success')
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '0' } }); driver.render()
      assert.equal(driver.one('select').props.value, 'single')
      driver.one('select').props.onChange({ target: { value: 'multiple' } }); driver.render()
      driver.one('input', p => p.type !== 'checkbox').props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { assert.fail('IME must not submit') } })
      await settle(driver); assert.equal(writes, 1)
      driver.one('input', p => p.type !== 'checkbox').props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} })
      await settle(driver); assert.equal(writes, 2); assert.equal(operation.plan.value, '0')
      assert.equal(operation.plan.functionCode, 16, 'user can write one word using FC16')
      assert.equal(calls.filter(c => c.path.endsWith('/prepare')).at(-1).body.method, 'multiple')
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '1' } }); driver.render()
      loseResponse = true; button(driver, writeLabel).props.onClick(); await settle(driver)
      assert.equal(writes, 3); assert(renderToStaticMarkup(driver.tree).includes('synthetic lost response'))
      const checks = calls.length
      button(driver, english ? 'Check result' : '查询结果').props.onClick(); await settle(driver)
      assert.equal(calls.length, checks + 1); assert.equal(writes, 3)
      assert.equal(button(driver, writeLabel).props.disabled, true)
      assert.equal(button(driver, english ? 'Record review' : '记录现场核实').props.disabled, true)
      driver.one('input', p => p.type === 'checkbox').props.onChange({ target: { checked: true } }); driver.render()
      button(driver, english ? 'Record review' : '记录现场核实').props.onClick(); await settle(driver)
      assert.equal(writes, 3); loseResponse = false
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '0' } }); driver.render()
      const staleButton = button(driver, writeLabel)
      driver.render({ ...props, source: { ...source, group: { ...source.group, slaveId: 9 } } })
      assert.equal(button(driver, writeLabel).props.disabled, true)
      staleButton.props.onClick(); await settle(driver); assert.equal(writes, 3, 'even a stale handler checks the latest source')
      button(driver, english ? 'Close' : '关闭').props.onClick(); assert.equal(closed, 1)
    } finally { driver.dispose() }
    const before = writes
    const restored = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { ...scope, writeRequest: request }, props)
    try { await settle(restored); assert.equal(writes, before); assert(calls.at(-1).body === undefined, 'reopen only queries the saved operation') } finally { restored.dispose() }
  }
  for (const mode of ['source-change', 'unmount'] as const) {
    memory.clear(); let finish!: (value: GuardedWriteResult) => void, executes = 0
    const props = { source, english: false, currentValue: '0', onClose() {} }
    const driver = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { ...scope, writeRequest: async (path: string) => {
      if (path.endsWith('/prepare')) return await new Promise<GuardedWriteResult>(resolve => { finish = resolve })
      executes++; return makeOperation()
    } }, props)
    await settle(driver)
    driver.one('input').props.onChange({ target: { value: '1' } }); driver.render()
    button(driver, '写入').props.onClick(); await settle(driver)
    if (mode === 'unmount') driver.dispose()
    else driver.render({ ...props, source: { ...source, group: { ...source.group, slaveId: 9 } } })
    finish(makeOperation()); await new Promise(resolve => setImmediate(resolve))
    if (mode !== 'unmount') { await settle(driver); driver.dispose() }
    assert.equal(executes, 0, 'source changes/unmount during automatic prepare cannot trigger a late write')
    assert.equal(driver.lateWrites, 0)
  }
  memory.clear()
  let old = makeOperation(), prepares = 0, executeCalls = 0
  const pendingDriver = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { ...scope, writeRequest: async (path: string) => {
    if (path.endsWith('/prepare')) { prepares++; return old }
    if (path.endsWith('/execute')) { executeCalls++; throw Error('delayed request; outcome unknown') }
    if (path.endsWith('/cancel')) { old = { ...old, state: 'not-sent', message: 'cancelled' }; return old }
    return old
  } }, { source, english: false, currentValue: '0', onClose() {} })
  try {
    await settle(pendingDriver); pendingDriver.one('input').props.onChange({ target: { value: '1' } }); pendingDriver.render()
    button(pendingDriver, '写入').props.onClick(); await settle(pendingDriver)
    button(pendingDriver, '查询结果').props.onClick(); await settle(pendingDriver)
    assert.equal(button(pendingDriver, '写入').props.disabled, true, 'prepared response cannot rule out a delayed execute')
    assert.equal(pendingDriver.one('input').props.disabled, true)
    assert.equal(prepares, 1); assert.equal(executeCalls, 1)
    button(pendingDriver, '取消待处理写入').props.onClick(); await settle(pendingDriver)
    assert.equal(pendingDriver.one('input').props.disabled, false)
    assert.equal(executeCalls, 1, 'cancel never sends a command')
  } finally { pendingDriver.dispose() }
  for (const [type, expected] of [['hex16', '0xff'], ['bin16', '0b11111111']]) {
    memory.clear(); memory.set('ps-register-write:' + JSON.stringify([source.device.id, source.device.transport, source.device.ip, source.device.port, source.device.serialPath, source.group.id, source.register.id]), makeOperation().id)
    const original = makeOperation('255'); original.plan.source = { ...source, register: { ...source.register, dataType: type } }; original.state = 'not-sent'
    const restored = hookDriver('RegisterWriteModal.tsx', 'RegisterWriteModal', { ...scope, writeRequest: async () => original }, { source: original.plan.source, currentValue: '0', english: false, onClose() {} })
    try { await settle(restored); assert.equal(restored.one('input').props.value, expected, 'restoring a raw-radix point must not reinterpret a decimal receipt as hex/binary') } finally { restored.dispose() }
  }
  console.log('BOUND WRITE UI OK: FC06/FC16 choice, one-click raw 0/1, automatic prepare/execute, Enter/IME, duplicate suppression, source/unmount races, response loss/query/cancellation, stale and radix receipt restoration')
} finally { if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else delete (globalThis as any).sessionStorage }
