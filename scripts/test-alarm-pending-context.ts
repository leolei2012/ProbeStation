import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { AlarmPendingContext, type AlarmPendingContextProps } from '../apps/web/src/AlarmPendingContext.tsx'
import { DeferredAlarmPendingContext, alarmPendingResource } from '../apps/web/src/DeferredAlarmPendingContext.tsx'
import { AlarmPanel } from '../apps/web/src/AlarmPanel.tsx'
import { AlarmHistoryAction } from '../apps/web/src/AlarmHistoryAction.tsx'
import { alarmHistoryState } from '../apps/web/src/alarm-history.ts'
import { openAlarmHistory } from '../apps/web/src/alarm-history.ts'
import { AlarmRulesReader } from '../apps/web/src/alarm-rule-read.ts'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { AlarmWriteGate, alarmOpeningState } from '../apps/web/src/alarm-settings-save.ts'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from '../apps/web/src/AlarmRuleReadStatus.tsx'
import { readPointAlarmObservation } from '../apps/web/src/alarm-value.ts'
import { alarmMatches } from '../packages/core/src/alarm.ts'
import { sourceKey, validSlaveId } from '../packages/core/src/sample-source.ts'
import { LiveWatchList } from '../apps/web/src/LiveWatchList.tsx'
import { captureLiveWatch, liveWatchResult } from '../apps/web/src/live-watch-list.ts'
import { evaluateLivePoints, livePointFilterResult } from '../apps/web/src/live-point-filter.ts'

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
await check('real reader and panel retain pagination safely across source edits, failed reads, invalid rules, deletion and late success', async () => {
  const points = Array.from({ length: 41 }, (_, i) => ({ ...reg, id: 101 + i, startAddress: i, alias: 'SOURCE-A-' + i }))
  const rules = points.map((point, i) => ({ ...rule, id: i + 1, registerId: point.id }))
  let response: () => Promise<unknown> = async () => rules, reads = 0, writes = 0
  const reader = new AlarmRulesReader(() => { reads++; return response() }, 10000)
  await reader.refresh()
  const latest = Object.fromEntries(points.map(point => [sourceKey(1, 'holding-register', point.startAddress, 1), { rawValue: 200, quality: 'good', timestamp: new Date(now).toISOString(), slaveId: 1, batchId: 'A' }]))
  let current = { t, device: { id: 1, isActive: 1, mode: 'master', slaveId: 9 }, groups: [{ ...group, slaveId: 2, registers: points }], latest, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { writes++; throw Error('no extra I/O') } }
  const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, symbols: { '>': '>' }, useAlarmRules: () => { const state = reader.snapshot(); return { rules: state.rules, ready: state.status === 'ready', reading: state.reading, state, lock: { current: false } } } }), current)
  panel.one('button', p => p.children === '查看待定规则').props.onClick(); panel.render()
  const details = () => panel.one(DeferredAlarmPendingContext).props as AlarmPendingContextProps
  const view = hookDriver('AlarmPendingContext.tsx', 'AlarmPendingContext', { validSlaveId }, details())
  const sync = () => { panel.render(current); view.render(details()); return renderToStaticMarkup(view.tree) }
  const next = () => { view.one('button', p => p.children === '下一页').props.onClick(); view.render() }
  next(); next(); assert.equal(view.one('ol').props.start, 41)
  assert.equal(details().rows.length, 41, 'fresh values from source A cannot fill source B')
  current = { ...current, groups: [{ ...current.groups[0], slaveId: 3, registers: points.map(point => ({ ...point, alias: 'SOURCE-C-' + point.id })) }] }
  let markup = sync(); assert(markup.includes('SOURCE-C-141') && markup.includes('配置从站 3')); assert(!markup.includes('SOURCE-A-'))
  current = { ...current, configurationReady: false }; markup = sync(); assert(markup.includes('尚未核实') && !markup.includes('SOURCE-C-') && !markup.includes('id:141'))
  current = { ...current, configurationReady: true }
  response = async () => { throw Error('PRIVATE-read-error') }; await reader.refresh(); markup = sync()
  assert(markup.includes('尚未核实') && !markup.includes('SOURCE-C-') && !markup.includes('PRIVATE-')); assert.equal(reader.snapshot().rules.length, 41)
  response = async () => [...rules, { ...rule, id: 99, operator: '?' }]; await reader.refresh(); markup = sync()
  assert(markup.includes('尚未核实') && !markup.includes('<li>'), 'invalid tail hides the entire retained page')
  response = async () => rules.slice(0, 21); await reader.refresh(); markup = sync()
  assert.equal(view.one('ol').props.start, 21); assert(markup.includes('SOURCE-C-121') && !markup.includes('SOURCE-C-141'))
  const obsolete = deferred<unknown>(); response = () => obsolete.promise; const old = reader.refresh(); await tick(); markup = sync()
  assert(markup.includes('尚未核实') && !markup.includes('SOURCE-C-'), 'in-flight refresh hides even a previously verified page')
  response = async () => []; await reader.refresh(true); markup = sync(); assert(markup.includes('不等同无告警或设备恢复')); assert(!markup.includes('<li>'))
  obsolete.resolve(rules); await old; await tick(); markup = sync(); assert(!markup.includes('SOURCE-C-') && !markup.includes('<li>'), 'late success cannot resurrect deleted rules')
  assert.equal(writes, 0); assert.equal(reads, 6); assert.equal(alarmPendingResource.snapshot().status, 'idle')
  reader.stop(); view.dispose(); panel.dispose()
})
await check('loaded paginated context never substitutes mixed-batch or missing-source words and recovers only with complete matching words', () => {
  const point = { ...reg, dataType: 'uint32' }, selectedGroup = { ...group, slaveId: 2, registers: [point] }
  const sample = (slaveId: number, batchId: string, rawValue: number) => ({ rawValue, quality: 'good', timestamp: new Date(now).toISOString(), slaveId, batchId })
  let latest: Record<string, ReturnType<typeof sample>> = { [sourceKey(1, 'holding-register', 0, 2)]: sample(2, 'B', 1), [sourceKey(1, 'holding-register', 1, 1)]: sample(1, 'A', 0) }
  const evaluate = () => readPointAlarmObservation(point, latest, { id: 1, isActive: 1 }, selectedGroup, now, 5000, false)
  const view = hookDriver('AlarmPendingContext.tsx', 'AlarmPendingContext', { validSlaveId }, { ...props, rows: [{ rule, reg: point, group: selectedGroup }] })
  const refresh = () => { const observation = evaluate(); view.render({ ...props, rows: observation ? [] : [{ rule, reg: point, group: selectedGroup }] }); return observation }
  assert.equal(refresh(), null); assert(renderToStaticMarkup(view.tree).includes('配置从站 2'))
  latest = { ...latest, [sourceKey(1, 'holding-register', 1, 2)]: sample(2, 'C', 0) }; assert.equal(refresh(), null)
  latest[sourceKey(1, 'holding-register', 1, 2)] = sample(2, 'B', 0); assert.equal(refresh()?.value, 65536)
  assert(renderToStaticMarkup(view.tree).includes('不等同无告警或设备恢复'))
  delete latest[sourceKey(1, 'holding-register', 0, 2)]; assert.equal(refresh(), null); assert(renderToStaticMarkup(view.tree).includes('id:101'))
  view.dispose()
})
await check('watch and search/slave filters can show no unknown rows while device context lists two rules for one other point', () => {
  const other = { ...reg, id: 102, alias: 'WATCHED POINT' }, groups = [{ ...group, functionCode: 3 }, { ...group, id: 2, name: 'Second slave', slaveId: 2, functionCode: 3, registers: [other] }]
  const rules = [rule, { ...rule, id: 12, operator: '<', threshold: -1 }], device = { id: 1, ...props.device }, token = Symbol('watch scope')
  const latest = { [sourceKey(1, 'holding-register', 0, 2)]: { rawValue: 1, quality: 'good', timestamp: new Date(now).toISOString(), slaveId: 2, batchId: 'B' } }
  const states = evaluateLivePoints(groups, new Map([[101, { covered: false, invalid: false }], [102, { covered: false, invalid: false }]]), latest, device, rules, {}, now, 5000)
  const filtered = livePointFilterResult(groups, states, 'id:102', '2', 'all'), selection = captureLiveWatch(token, new Set([102]), groups)!
  const watch = liveWatchResult(selection, token, true, filtered.visibleIds)
  assert.deepEqual([...watch.visibleIds], [102]); assert.equal(filtered.counts.unknown, 0)
  const full = livePointFilterResult(groups, states, '', '', 'all'); assert.equal(full.counts.unknown, 1, 'row count is one point even when it has two pending rules')
  let requests = 0
  const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, symbols: {}, useAlarmRules: () => ({ rules, ready: true, reading: false, state: { status: 'ready', reading: false, rules, updatedAt: now }, lock: { current: false } }) }), { t, device, groups, latest, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { requests++; throw Error('no I/O') } })
  try {
    panel.one('button', p => p.children === '查看待定规则').props.onClick(); panel.render()
    const pending = panel.one(DeferredAlarmPendingContext).props as AlarmPendingContextProps
    assert.deepEqual(pending.rows.map(row => row.reg.id), [101, 101]); assert.equal(pending.rows.length, 2)
    for (const english of [false, true]) {
      const context = html({ ...pending, english })
      assert(context.includes(english ? 'not narrowed by watch list' : '不随观察清单'), 'pending context must state its independent device scope')
      assert(context.includes(english ? 'rule entries' : '规则条数'), 'rule count must not be presented as a point count')
      const watchMarkup = renderToStaticMarkup(React.createElement(LiveWatchList, { selection, scope: token, only: true, matches: filtered.visibleIds, groups, t, english, onSelect() {}, onOnly() {}, onClear() {} }))
      assert(watchMarkup.includes(english ? 'pending-rule list' : '待定规则清单'), 'watch-only must explain why the pending list can still contain other points')
    }
    assert.equal(liveWatchResult(selection, Symbol('changed'), true, filtered.visibleIds).visibleIds.size, 0)
    assert.equal(pending.rows.length, 2); assert.equal(requests, 0)
  } finally { panel.dispose() }
})
await check('point association lookup stays linear while preserving first definition, rule order and same-reference edits', () => {
  let idReads = 0
  const points = Array.from({ length: 1000 }, (_, i) => Object.defineProperty({ ...reg, id: i + 1 }, 'id', { enumerable: true, get() { idReads++; return i + 1 } }))
  const groups = [{ ...group, registers: points }, { ...group, id: 2, slaveId: 2, registers: [{ ...reg, id: 1000, alias: 'WRONG DUPLICATE' }] }]
  const rules = [...Array.from({ length: 1000 }, (_, i) => ({ ...rule, id: i + 1, registerId: 1000 })), { ...rule, id: 1001, registerId: 999999 }]
  const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, symbols: {}, useAlarmRules: () => ({ rules, ready: true, reading: false, state: { status: 'ready', reading: false, rules, updatedAt: now }, lock: { current: false } }) }), { t, device: { id: 1, ...props.device }, groups, latest: {}, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { assert.fail('no I/O') } })
  try {
    panel.one('button', p => p.children === '查看待定规则').props.onClick(); panel.render(); idReads = 0; panel.render()
    const observedReads = idReads, detail = () => panel.one(DeferredAlarmPendingContext).props as AlarmPendingContextProps
    assert.equal(detail().rows.length, 1000); assert.equal(detail().rows[0].reg, points[999]); assert.equal(detail().rows[0].group.id, 1)
    assert.deepEqual(detail().rows.map(row => row.rule.id), rules.slice(0, 1000).map(rule => rule.id))
    groups[0].registers[999] = { ...reg, id: 1000, alias: 'UPDATED IN SAME ARRAY' }; groups[0].slaveId = 3; panel.render()
    assert.equal(detail().rows[0].reg.alias, 'UPDATED IN SAME ARRAY'); assert.equal(detail().rows[0].group.slaveId, 3)
    console.log('PENDING LOOKUP ID READS: ' + observedReads + '; 1000 points / 1000 rules plus duplicate and missing definition')
    assert(observedReads < 40000, 'rule-to-point association must not repeatedly scan the whole point table')
  } finally { panel.dispose() }
})
await check('synthetic large-rule refresh separates full-panel evaluation from bounded pending-page rendering', () => {
  const measurements: unknown[] = []
  for (const size of [1000, 5000, 10000]) {
    const points = Array.from({ length: size }, (_, i) => ({ ...reg, id: i + 1, startAddress: i })), groups = [{ ...group, registers: points }]
    const rules = points.map(point => ({ ...rule, id: point.id, registerId: point.id }))
    const panelProps = { t, device: { id: 1, ...props.device }, groups, latest: {}, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { assert.fail('no I/O') } }
    const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, symbols: {}, useAlarmRules: () => ({ rules, ready: true, reading: false, state: { status: 'ready', reading: false, rules, updatedAt: now }, lock: { current: false } }) }), panelProps)
    panel.one('button', p => p.children === '查看待定规则').props.onClick(); panel.render()
    const samples: number[] = []
    for (let i = 0; i < 5; i++) { const start = performance.now(); panel.render({ ...panelProps, now: now + i }); samples.push(performance.now() - start) }
    const detail = panel.one(DeferredAlarmPendingContext).props as AlarmPendingContextProps
    assert.equal(detail.rows.length, size)
    const view = hookDriver('AlarmPendingContext.tsx', 'AlarmPendingContext', { validSlaveId }, detail), pageSamples: number[] = []
    for (let i = 0; i < 5; i++) { const start = performance.now(); view.render(detail); renderToStaticMarkup(view.tree); pageSamples.push(performance.now() - start) }
    assert.equal(elements(view.tree).filter(node => node.type === 'li').length, 20)
    view.one('button', p => p.children === '下一页').props.onClick(); view.render(); assert.equal(view.one('ol').props.start, 21)
    view.render({ ...detail, rows: detail.rows.slice(0, 1) }); assert.equal(view.one('ol').props.start, 1)
    view.render({ ...detail, current: false }); const hidden = renderToStaticMarkup(view.tree); assert(hidden.includes('尚未核实') && !hidden.includes('<li>'))
    measurements.push({ points: size, rules: size, panelMedianMs: samples.sort((a, b) => a - b)[2], page20SsrMedianMs: pageSamples.sort((a, b) => a - b)[2] })
    view.dispose(); panel.dispose()
  }
  console.log('PENDING SCALE MEASURE: ' + JSON.stringify(measurements) + '; synthetic Node component refresh / SSR, not browser latency or a capacity guarantee')
})
await check('matching cards are bounded without hiding rule totals, and paged history follows the displayed source and current verification', () => {
  const points = Array.from({ length: 41 }, (_, i) => ({ ...reg, id: 101 + i, startAddress: i, alias: 'MATCH-' + i }))
  let rules = points.map(point => ({ ...rule, id: point.id, registerId: point.id })), ready = true, reading = false, clock = now
  const groups = [{ ...group, slaveId: 2, registers: points }], latest = Object.fromEntries(points.map(point => [sourceKey(1, 'holding-register', point.startAddress, 2), { rawValue: 200, quality: 'good', timestamp: new Date(now).toISOString(), slaveId: 2, batchId: 'B' }]))
  const targets: any[] = [], value = { t, device: { id: 1, ...props.device }, groups, latest, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { assert.fail('no I/O') }, onHistory(target: unknown) { targets.push(target) } }
  const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, AlarmHistoryAction, alarmHistoryState, Date: { now: () => clock }, symbols: { '>': '>' }, useAlarmRules: () => ({ rules, ready, reading, state: { status: ready ? 'ready' : 'error', reading, rules, updatedAt: now }, lock: { current: false } }) }), value)
  const cards = () => elements(panel.tree).filter(node => node.type === AlarmHistoryAction)
  const pager = () => panel.one('div', p => p.role === 'group' && p.className === 'toolbar')
  const next = () => { const button = elements(pager()).find(node => node.type === 'button' && node.props.children === '下一页')!; button.props.onClick(); panel.render() }
  try {
    for (const size of [1, 20, 21, 40, 41]) { rules = points.slice(0, size).map(point => ({ ...rule, id: point.id, registerId: point.id })); panel.render(); assert.equal(cards().length, Math.min(size, 20), 'only the displayed card page should be constructed') }
    assert(renderToStaticMarkup(pager()).includes('41'))
    const jump = (page: number) => { panel.one('input', p => p.type === 'number').props.onChange({ currentTarget: { valueAsNumber: page } }); panel.render() }
    for (const invalid of [NaN, 0, -1, 1.5, 4, Infinity]) { jump(invalid); assert.equal(cards()[0].props.state.registerId, 101) }
    jump(3); assert.equal(cards()[0].props.state.registerId, 141); jump(1)
    const seen = [...cards().map(node => node.props.state.registerId)]; next(); seen.push(...cards().map(node => node.props.state.registerId)); next(); seen.push(...cards().map(node => node.props.state.registerId))
    assert.deepEqual(seen, points.map(point => point.id)); assert.equal(cards().length, 1)
    const action = cards()[0].props; assert.equal(action.state.registerId, 141); assert.equal(action.state.slaveId, 2)
    assert.equal(openAlarmHistory(action.resolve, value.onHistory).kind, 'ready'); assert.equal(targets.length, 1); assert.equal(targets[0].registerId, 141)
    reading = true; panel.render(); assert.equal(cards()[0].props.state.kind, 'rules')
    reading = false; ready = false; panel.render(); assert.equal(cards()[0].props.state.kind, 'rules')
    ready = true; panel.render({ ...value, configurationReady: false }); assert.equal(cards()[0].props.state.kind, 'waiting')
    panel.render(value); clock = now + 6000; assert.equal(openAlarmHistory(cards()[0].props.resolve, value.onHistory).kind, 'time'); assert.equal(targets.length, 1)
    clock = now; panel.render({ ...value, t: (key: string) => key === 'cancel' ? 'Cancel' : key }); assert(renderToStaticMarkup(pager()).includes('Cached matching rules')); assert(renderToStaticMarkup(panel.tree).includes('browser Find covers only the displayed page'))
    rules = rules.slice(0, 1); panel.render(value); assert.equal(cards().length, 1); assert.equal(cards()[0].props.state.registerId, 101)
    rules = []; panel.render(); assert.equal(cards().length, 0); assert.throws(() => pager()); assert.equal(targets.length, 1)
  } finally { panel.dispose() }
})
await check('live matching-card shrink/grow keeps the clamped page, isolates new sources and keeps native keyboard attributes', () => {
  const points = Array.from({ length: 41 }, (_, i) => ({ ...reg, id: 101 + i, startAddress: i, alias: 'LIVE-' + i })), rules = points.map(point => ({ ...rule, id: point.id, registerId: point.id }))
  const groups = [{ ...group, slaveId: 2, registers: points }]
  const samples = (source: number, count = 41) => Object.fromEntries(points.map((point, i) => [sourceKey(1, 'holding-register', i, source), { rawValue: i < count ? 200 : 0, quality: 'good', timestamp: new Date(now).toISOString(), slaveId: source, batchId: 'source-' + source }]))
  let calls = 0, opens = 0, current = { t, device: { id: 1, ...props.device }, groups, latest: samples(2), groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { assert.fail('no I/O') }, onHistory() { opens++ } }
  const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation: (...args: Parameters<typeof readPointAlarmObservation>) => { calls++; return readPointAlarmObservation(...args) }, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, AlarmHistoryAction, alarmHistoryState, Date: { now: () => now }, symbols: { '>': '>' }, useAlarmRules: () => ({ rules, ready: true, reading: false, state: { status: 'ready', reading: false, rules, updatedAt: now }, lock: { current: false } }) }), current)
  const cards = () => elements(panel.tree).filter(node => node.type === AlarmHistoryAction)
  const jump = (page: number) => { panel.one('input', p => p.type === 'number').props.onChange({ currentTarget: { valueAsNumber: page } }); panel.render(current) }
  const refresh = (source: number, count = 41) => { current = { ...current, latest: samples(source, count) }; calls = 0; panel.render(current); assert.equal(calls, 41, 'pagination does not filter rule evaluation') }
  try {
    const input = panel.one('input', p => p.type === 'number').props
    assert.equal(input['aria-label'], '命中规则页码'); assert.equal(input.min, 1); assert.equal(input.max, 3); assert.equal(input.step, 1)
    assert.equal(input.onKeyDown, undefined); assert.equal(input.tabIndex, undefined, 'native spinbutton and tab behavior are not replaced')
    for (const button of elements(panel.one('div', p => p.role === 'group' && p.className === 'toolbar')).filter(node => node.type === 'button')) assert.equal(button.props.type, 'button')
    jump(3); assert.equal(cards()[0].props.state.registerId, 141)
    refresh(2, 1); assert.equal(cards()[0].props.state.registerId, 101)
    refresh(2); assert.equal(cards()[0].props.state.registerId, 101, 'growing again must not resurrect the old out-of-range page')
    jump(3); refresh(2, 21); assert.equal(cards()[0].props.state.registerId, 121)
    refresh(2); assert.equal(cards()[0].props.state.registerId, 121)
    assert(renderToStaticMarkup(panel.tree).includes('缓存命中规则 41 条'))
    groups[0].slaveId = 3; calls = 0; panel.render(current); assert.equal(calls, 41); assert.equal(cards().length, 0, 'source 2 values cannot supply source 3 matching cards'); assert(renderToStaticMarkup(panel.tree).includes('alarmWaiting'), 'unknown new-source values must not report a normal summary')
    refresh(3); assert.equal(cards()[0].props.state.registerId, 101); assert(cards().every(node => node.props.state.slaveId === 3))
    assert.equal(openAlarmHistory(cards()[0].props.resolve, current.onHistory).kind, 'ready'); assert.equal(opens, 1)
    const next = elements(panel.one('div', p => p.role === 'group' && p.className === 'toolbar')).find(node => node.type === 'button' && node.props.children === '下一页')!
    next.props.onClick(); panel.render(current); assert.equal(cards()[0].props.state.registerId, 121, 'button activation changes only the display page')
    refresh(3, 0); assert.equal(cards().length, 0); refresh(3); assert.equal(cards()[0].props.state.registerId, 101); assert.equal(opens, 1)
  } finally { panel.dispose() }
})
await check('synthetic matching-rule cards measure render work with history actions without opening history', () => {
  const measurements: unknown[] = []
  for (const size of [1000, 5000, 10000]) {
    const points = Array.from({ length: size }, (_, i) => ({ ...reg, id: i + 1, alias: 'SYNTHETIC-' + (i + 1), startAddress: i })), groups = [{ ...group, registers: points }]
    const rules = points.map(point => ({ ...rule, id: point.id, registerId: point.id }))
    const latest = Object.fromEntries(points.map(point => [sourceKey(1, 'holding-register', point.startAddress, 1), { rawValue: 200, quality: 'good', timestamp: new Date(now).toISOString(), slaveId: 1, batchId: 'synthetic' }]))
    let opens = 0
    const value = { t, device: { id: 1, ...props.device }, groups, latest, groupErrors: {}, now, threshold: 5000, configurationReady: true, api: async () => { assert.fail('no I/O') }, onHistory() { opens++ } }
    const panel = hookDriver('AlarmPanel.tsx', 'AlarmPanel', scope({ AlarmWriteGate, alarmOpeningState, readPointAlarmObservation, alarmMatches, alarmRuleSummaryKey, AlarmRuleReadStatus, DeferredAlarmPendingContext, AlarmHistoryAction, alarmHistoryState, symbols: { '>': '>' }, useAlarmRules: () => ({ rules, ready: true, reading: false, state: { status: 'ready', reading: false, rules, updatedAt: now }, lock: { current: false } }) }), value)
    try {
      const samples: number[] = [], ssr: number[] = []; let markup = ''
      for (let i = 0; i < 5; i++) { let start = performance.now(); panel.render({ ...value, now: now + i }); samples.push(performance.now() - start); start = performance.now(); markup = renderToStaticMarkup(panel.tree); ssr.push(performance.now() - start) }
      const cards = elements(panel.one('div', p => p.className === 'alarm-active-list')).filter(node => node.type === AlarmHistoryAction).length
      assert.equal(opens, 0)
      measurements.push({ matchingRules: size, historyActionsRendered: cards, panelMedianMs: samples.sort((a, b) => a - b)[2], ssrMedianMs: ssr.sort((a, b) => a - b)[2], markupBytes: Buffer.byteLength(markup) })
    } finally { panel.dispose() }
  }
  console.log('ACTIVE SCALE MEASURE: ' + JSON.stringify(measurements) + '; Node component/SSR with synthetic valid samples, not browser/network/capacity evidence')
})
console.log(`ALARM PENDING TEST OK: ${passed} groups; production panel, source-scoped pending evaluations, neutral bilingual context, pagination and deferred error/lifecycle; component mocks only, no API/device/database/model/browser.`)
