import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { AlarmPendingContext, type AlarmPendingContextProps } from '../apps/web/src/AlarmPendingContext.tsx'
import { DeferredAlarmPendingContext, alarmPendingResource } from '../apps/web/src/DeferredAlarmPendingContext.tsx'
import { AlarmPanel } from '../apps/web/src/AlarmPanel.tsx'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { AlarmWriteGate, alarmOpeningState } from '../apps/web/src/alarm-settings-save.ts'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from '../apps/web/src/AlarmRuleReadStatus.tsx'
import { readPointAlarmObservation } from '../apps/web/src/alarm-value.ts'
import { alarmMatches } from '../packages/core/src/alarm.ts'
import { sourceKey, validSlaveId } from '../packages/core/src/sample-source.ts'

const now = Date.parse('2026-11-09T00:00:00.000Z'), t = (key: string) => key === 'cancel' ? '取消' : key
const reg = { id: 101, alias: '同地址温度', startAddress: 0, dataType: 'uint16', functionCode: 3 }
const group = { id: 1, name: '第一组', isActive: 1, slaveId: 1, registers: [reg] }
const rule = { id: 11, registerId: reg.id, operator: '>', threshold: 100, message: null }
const row = { rule, reg, group }
const props: AlarmPendingContextProps = { current: true, device: { isActive: 1, mode: 'master', slaveId: 9 }, groupErrors: {}, rows: [row] }
const html = (value = props) => renderToStaticMarkup(React.createElement(AlarmPendingContext, value))
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const scope = (extra: Record<string, unknown>) => (hooks: Record<string, any>) => ({ ...extra,
  useMemo(factory: () => unknown, deps: unknown[]) { const ref = hooks.useRef(); if (!ref.current || deps.some((v, i) => !Object.is(v, ref.current.deps[i]))) ref.current = { value: factory(), deps }; return ref.current.value },
  useSyncExternalStore(subscribe: (notify: () => void) => () => void, snapshot: () => unknown) { hooks.useEffect(() => subscribe(() => {}), [subscribe]); return snapshot() },
})
let passed = 0
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log('ALARM PENDING OK: ' + name) }

await check('closed production panel imports no context, reads nothing during SSR and leaves point editor unchanged', () => {
  let requests = 0
  const panelProps = { t, device: { id: 1, isActive: 1 }, groups: [group], latest: {}, groupErrors: {}, now, threshold: 5000, api: async () => { requests++; throw Error('no read or write allowed') } }
  const closed = renderToStaticMarkup(React.createElement(AlarmPanel, panelProps))
  assert(closed.includes('查看待定规则') && closed.includes('aria-expanded="false"')); assert(!closed.includes('本页待定规则上下文'))
  const editor = renderToStaticMarkup(React.createElement(AlarmPanel, { ...panelProps, point: reg }))
  assert(!editor.includes('查看待定规则')); assert.equal(requests, 0); assert.equal(alarmPendingResource.snapshot().status, 'idle')
})
await check('bilingual configuration source, raw conditions and page flags never infer a root cause or expose diagnostics', () => {
  for (const english of [false, true]) {
    const rendered = html({ ...props, english, groupErrors: { 1: 'PRIVATE-error-with-endpoint' }, device: { ...props.device, isActive: 0 } })
    assert(rendered.includes('id:101') && rendered.includes('#11'))
    assert(rendered.includes(english ? 'Configured slave<!-- --> <!-- -->1' : '配置从站<!-- --> <!-- -->1') || /(?:配置从站|Configured slave) 1/.test(rendered))
    assert(rendered.includes(english ? 'Raw condition' : '原始值条件')); assert(rendered.includes('&gt;') && rendered.includes('100'))
    assert(rendered.includes(english ? 'paused' : '暂停')); assert(rendered.includes(english ? 'present' : '有'))
    assert(rendered.includes(english ? 'not root causes' : '不是根因')); assert(!rendered.includes('PRIVATE-'))
    assert(html({ ...props, english, device: { ...props.device, mode: 'slave', slaveId: 7 } }).includes(english ? 'Configured slave 7' : '配置从站 7'))
    assert(html({ ...props, english, rows: [{ ...row, group: { ...group, slaveId: undefined } }] }).includes(english ? 'Configured slave ?' : '配置从站 ?'))
  }
  const escaped = html({ ...props, rows: [{ ...row, reg: { ...reg, alias: '<script>PRIVATE</script>' }, group: { ...group, name: '长名称'.repeat(100) } }] })
  assert(escaped.includes('&lt;script&gt;') && !escaped.includes('<script>'))
})
await check('unverified configurations hide retained details, while verified empty state never claims recovery', () => {
  for (const english of [false, true]) {
    const withheld = html({ ...props, english, current: false })
    assert(withheld.includes(english ? 'unverified' : '尚未核实')); assert(!withheld.includes('同地址温度') && !withheld.includes('id:101'))
    const empty = html({ ...props, english, rows: [] })
    assert(empty.includes(english ? 'does not mean no alarms or device recovery' : '不等同无告警或设备恢复'))
  }
})
await check('bounded pagination exposes all rules without silent truncation and clamps after live list changes', () => {
  const rows = Array.from({ length: 41 }, (_, i) => ({ ...row, rule: { ...rule, id: i + 1 }, reg: { ...reg, id: i + 101 } }))
  const driver = hookDriver('AlarmPendingContext.tsx', 'AlarmPendingContext', { validSlaveId }, { ...props, rows })
  const items = () => elements(driver.tree).filter(node => node.type === 'li')
  assert.equal(items().length, 20); assert.equal(driver.one('button', p => p.children === '上一页').props.disabled, true)
  driver.one('button', p => p.children === '下一页').props.onClick(); driver.render(); assert.equal(driver.one('ol').props.start, 21); assert.equal(items().length, 20)
  driver.one('button', p => p.children === '下一页').props.onClick(); driver.render(); assert.equal(driver.one('ol').props.start, 41); assert.equal(items().length, 1)
  assert.equal(driver.one('button', p => p.children === '下一页').props.disabled, true)
  driver.render({ ...props, rows: rows.slice(0, 21) }); assert.equal(driver.one('ol').props.start, 21)
  driver.render({ ...props, rows: [] }); assert.equal(items().length, 0); assert.throws(() => driver.one('button'))
  driver.dispose()
})
await check('actual panel passes only pending same-source evaluations, observes recovery and gates refreshing rules', () => {
  const second = { ...reg, id: 102 }, third = { ...reg, id: 103 }
  const groups = [group, { ...group, id: 2, slaveId: 2, registers: [second] }, { ...group, id: 3, isActive: 0, slaveId: 3, registers: [third] }]
  let ready = true, reading = false, requests = 0
  const rules = [rule, { ...rule, id: 12, registerId: 102 }, { ...rule, id: 13, registerId: 103 }]
  const sample = (slaveId: number) => ({ rawValue: 200, quality: 'good', timestamp: new Date(now).toISOString(), slaveId, batchId: 'private-batch-' + slaveId })
  let panelProps = { t, device: { id: 1, isActive: 1, mode: 'master', slaveId: 9 }, groups, latest: { [sourceKey(1, 'holding-register', 0, 1)]: sample(1) }, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { requests++; throw Error('no new requests') } }
  const driver = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, symbols: { '>': '>' }, useAlarmRules: () => ({ rules, ready, reading, state: { status: ready ? 'ready' : 'error', reading, rules, updatedAt: now }, lock: { current: false } }) }), panelProps)
  assert.throws(() => driver.one(DeferredAlarmPendingContext))
  driver.one('button', p => p.children === '查看待定规则').props.onClick(); driver.render()
  const detail = () => driver.one(DeferredAlarmPendingContext).props as AlarmPendingContextProps
  assert.deepEqual(detail().rows.map(r => r.reg.id), [102, 103]); assert.equal(detail().current, true)
  assert.deepEqual(Object.keys(detail().device).sort(), ['isActive', 'mode', 'slaveId'])
  panelProps = { ...panelProps, latest: { ...panelProps.latest, [sourceKey(1, 'holding-register', 0, 2)]: sample(2) } }; driver.render(panelProps)
  assert.deepEqual(detail().rows.map(r => r.reg.id), [103], 'source 1 cannot fill source 2; complete source 2 update removes only its pending rule')
  reading = true; driver.render(); assert.equal(detail().current, false)
  reading = false; ready = false; driver.render(); assert.equal(detail().current, false)
  ready = true; driver.render({ ...panelProps, configurationReady: false }); assert.equal(detail().current, false)
  driver.one('button', p => p.children === '收起待定规则').props.onClick(); driver.render(); assert.throws(() => detail())
  assert.equal(requests, 0); assert.equal(alarmPendingResource.snapshot().status, 'idle'); driver.dispose()
})
const wrapper = (resource: typeof alarmPendingResource, value = props) => hookDriver('DeferredAlarmPendingContext.tsx', 'DeferredAlarmPendingContext', scope({ alarmPendingResource }), { ...value, resource })
await check('late code uses current props and closing removes subscribers without reopening or stale state writes', async () => {
  const code = deferred<typeof AlarmPendingContext>(); let imports = 0
  const resource = new DeferredResource(async () => { imports++; return code.promise })
  const driver = wrapper(resource); await tick(); assert.equal(imports, 1)
  const next = { ...props, current: false, rows: [] }; driver.render({ ...next, resource })
  code.resolve(AlarmPendingContext); await resource.load(); driver.render({ ...next, resource })
  assert.equal(driver.one(AlarmPendingContext).props.current, false); assert.equal(driver.one(AlarmPendingContext).props.rows.length, 0)
  driver.dispose(); assert.equal(driver.lateWrites, 0)
  const late = deferred<typeof AlarmPendingContext>(), closedResource = new DeferredResource(() => late.promise), closed = wrapper(closedResource)
  await tick(); closed.dispose(); late.resolve(AlarmPendingContext); await closedResource.load(); assert.equal(closed.lateWrites, 0)
  const reopened = wrapper(closedResource); assert.equal(reopened.one(AlarmPendingContext).props.rows, props.rows); reopened.dispose()
})
await check('bilingual failures retry display code only, cached failure does not retry on reopening', async () => {
  for (const english of [false, true]) {
    let imports = 0
    const resource = new DeferredResource(async () => { if (++imports === 1) throw Error('PRIVATE-chunk-error'); return AlarmPendingContext })
    const driver = wrapper(resource, { ...props, english }); await resource.load(); driver.render()
    const failed = renderToStaticMarkup(driver.tree); assert(failed.includes('role="alert"') && !failed.includes('PRIVATE-'))
    driver.dispose(); const reopened = wrapper(resource, { ...props, english }); await tick(); assert.equal(imports, 1)
    reopened.one('button').props.onClick(); await resource.load(); reopened.render(); assert.equal(imports, 2); assert.equal(reopened.one(AlarmPendingContext).props.rows, props.rows); reopened.dispose()
  }
})
await check('timed-out code cannot overwrite explicit retry', async () => {
  let imports = 0; const late = deferred<typeof AlarmPendingContext>()
  const resource = new DeferredResource(async () => ++imports === 1 ? late.promise : AlarmPendingContext, 10)
  const driver = wrapper(resource); await resource.load(); driver.render(); assert(driver.one('p').props.role === 'alert')
  driver.one('button').props.onClick(); await resource.load(); driver.render(); const accepted = resource.snapshot(); late.resolve(AlarmPendingContext); await tick(); driver.render(); assert.equal(resource.snapshot(), accepted)
  assert.equal(driver.one(AlarmPendingContext).props.rows, props.rows); driver.dispose()
})
console.log(`ALARM PENDING TEST OK: ${passed} groups; production panel, source-scoped pending evaluations, neutral bilingual context, pagination and deferred error/lifecycle; component mocks only, no API/device/database/model/browser.`)
