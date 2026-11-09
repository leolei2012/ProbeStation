import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { captureLiveSnapshot, liveSnapshotJson, downloadLiveSnapshot, liveSnapshotFilename } from '../apps/web/src/live-snapshot.ts'
import { compareLiveSnapshots, liveSnapshotComparisonKey, type FrozenLiveObservation } from '../apps/web/src/live-snapshot-comparison.ts'
import { LiveSnapshotComparison } from '../apps/web/src/LiveSnapshotComparison.tsx'
import { encodeRegister, decodeRegister } from '../packages/core/src/codec.ts'
import * as codec from '../packages/core/src/codec.ts'
import { sourceKey, configuredSourceSample as sourceSample } from '../packages/core/src/sample-source.ts'
import { sameResponseBatch } from '../packages/core/src/sample-batch.ts'
import { RealtimeFallbackRead } from '../apps/web/src/realtime-fallback.ts'
import { displayNumber, physicalValue } from '../apps/web/src/physical-value.ts'
import { evaluateLivePoints } from '../apps/web/src/live-point-filter.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { syntheticDevice } from './fixtures/draft-navigation-driver.ts'
import type { Sample } from '../apps/web/src/observation.ts'

const origin = 1800000000000, token = Symbol('source'), device = { ...syntheticDevice, isActive: 1 }
function input(values: Array<number | bigint> = [10, 20], step = 0, type = 'uint16', batch: string | null = 'batch-' + step) {
  const points = values.map((_, i) => ({ id: i + 1, objectId: 1, groupId: 10, alias: i === 0 ? '<first>' : 'point ' + i, startAddress: i * 4, functionCode: 3, dataType: type, factor: 0, offset: 5, unit: 'V', decimalPlaces: 0, enumJson: null as string | null }))
  const groups = [{ id: 10, objectId: 1, name: 'synthetic', slaveId: 1, isActive: 1, functionCode: 3, startAddress: 0, quantity: values.length * 4, registers: points }]
  const latest: Record<string, Sample> = {}, views = new Map()
  for (const [i, point] of points.entries()) {
    const words = encodeRegister(type, values[i]), decoded = decodeRegister(type, words)
    views.set(point.id, { value: displayNumber(decoded, point), label: null, covered: false, invalid: false, physical: physicalValue(decoded, point) })
    for (const [offset, rawValue] of words.entries()) latest[sourceKey(1, 'holding-register', point.startAddress + offset, 1)] = { rawValue, quality: 'good', timestamp: new Date(origin + step).toISOString(), timestampMs: origin + step, batchId: batch, slaveId: 1 }
  }
  const states = evaluateLivePoints(groups, views, latest, device, [], {}, origin + step, 5000)
  return { device, groups, visibleIds: new Set(points.map(point => point.id)), views, states, latest, filters: { search: '', source: '', mode: 'all' }, rulesReady: true, observedAt: origin + step, capturedAt: origin + step, thresholdMs: 5000 }
}
const freeze = (value = input(), scope: symbol | null = token): FrozenLiveObservation => Object.freeze({ scope, snapshot: captureLiveSnapshot(value) })
const changed = (a: FrozenLiveObservation, b: FrozenLiveObservation) => compareLiveSnapshots(a, b, token)
function ui(current: FrozenLiveObservation | null, english = false, scope: symbol | null = token) {
  const driver = hookDriver('LiveSnapshotComparison.tsx', 'LiveSnapshotComparison', { compareLiveSnapshots, useMemo: (fn: () => unknown) => fn() }, { current, scope, english })
  return { driver, update(next: FrozenLiveObservation | null, nextScope: symbol | null = scope) { current = next; scope = nextScope; driver.render({ current, scope, english }) }, html: () => renderToStaticMarkup(driver.tree), baseline() { driver.one('button', p => String(p.children).includes(english ? 'snapshot as baseline' : '设为基线')).props.onClick(); driver.render() } }
}
let passed = 0
async function check(name: string, action: () => void | Promise<void>) { await action(); passed++; console.log('SNAPSHOT COMPARE OK: ' + name) }
await check('exact raw words distinguish changed unchanged and unavailable without display-text math', () => {
  const a = freeze(), b = freeze(input([11, 20], 1000)), result = changed(a, b)
  assert.equal(result.status, 'ready'); assert.deepEqual(result.counts, { changed: 1, unchanged: 1, unknown: 0 }); assert.equal(result.rows[0].before.display.physical, '5'); assert.equal(result.rows[0].after.display.physical, '5'); assert.equal(result.rows[0].state, 'changed')
  const large = 9223372036854775808n, big = changed(freeze(input([large], 0, 'uint64')), freeze(input([large + 1n], 1000, 'uint64'))); assert.equal(big.rows[0].state, 'changed'); assert.equal(big.rows[0].after.display.raw, '9223372036854775809')
  const float = changed(freeze(input([1.001], 0, 'float32')), freeze(input([1.002], 1000, 'float32'))); assert.equal(float.rows[0].before.display.raw, float.rows[0].after.display.raw); assert.equal(float.rows[0].state, 'changed')
  assert.equal(compareLiveSnapshots(a, a, token).status, 'empty'); assert.equal(compareLiveSnapshots(null, b, token).status, 'empty')
})
await check('different scope source or definition never becomes a value-change assertion', () => {
  const a = freeze(), b = freeze(input([11, 20], 1000)); assert.equal(compareLiveSnapshots(a, b, Symbol('source')).status, 'context'); assert.equal(compareLiveSnapshots(a, b, null).status, 'unverified')
  const source = input([11, 20], 1000); source.groups[0].slaveId = 2; assert(changed(a, freeze(source)).rows.every(row => row.state === 'unknown'))
  const definition = input([11, 20], 1000); definition.groups[0].registers[0].factor = 1; assert.equal(changed(a, freeze(definition)).rows[0].reason, 'definition')
  const selection = input([11], 1000); assert.equal(changed(a, freeze(selection)).status, 'selection'); const filters = input([11, 20], 1000); filters.filters.search = 'id:1'; assert.equal(changed(a, freeze(filters)).status, 'selection')
  assert.equal(changed(freeze(input([1], 1000)), freeze(input([2], 0))).status, 'time')
})
await check('same batch stale bad missing covered legacy and mixed words stay not comparable', () => {
  const a = freeze(input([10], 0, 'uint32'))
  assert.equal(changed(a, freeze(input([11], 1000, 'uint32', 'batch-0'))).rows[0].reason, 'not-new')
  assert.equal(changed(a, freeze(input([11], 1000, 'uint32', null))).rows[0].reason, 'samples')
  for (const kind of ['missing', 'bad', 'stale', 'future', 'backwards', 'mixed', 'covered', 'paused'] as const) {
    const b = input([11], 1000, 'uint32'), key = sourceKey(1, 'holding-register', 0, 1)
    if (kind === 'missing') delete b.latest[key]; if (kind === 'bad') b.latest[key].quality = 'bad'; if (kind === 'stale') b.latest[key].timestampMs = origin - 10000; if (kind === 'future') b.latest[key].timestampMs = origin + 1e20; if (kind === 'backwards') b.latest[key].timestampMs = origin - 1; if (kind === 'mixed') b.latest[key].batchId = 'mixed'; if (kind === 'covered') b.views.get(1).covered = true; if (kind === 'paused') b.device = { ...device, isActive: 0 }
    b.states = evaluateLivePoints(b.groups, b.views, b.latest, b.device, [], {}, b.observedAt, b.thresholdMs); assert.equal(changed(a, freeze(b)).rows[0].state, 'unknown', kind)
  }
  const singleA = freeze(input([1], 0, 'uint16', null)), singleB = freeze(input([2], 1000, 'uint16', null)); assert.equal(changed(singleA, singleB).rows[0].state, 'changed'); assert.equal(changed(singleA, freeze(input([2], 0, 'uint16', null))).rows[0].reason, 'not-new')
  const sameMs = input([11], 0, 'uint32', 'another-batch'); assert.equal(changed(a, freeze(sameMs)).rows[0].state, 'changed', 'different complete batch IDs can arrive in the same millisecond')
  const invalidFunction = (step: number) => { const data = input([step], step); data.groups[0].functionCode = 17; data.groups[0].registers[0].functionCode = 17; return freeze(data) }; assert.equal(changed(invalidFunction(0), invalidFunction(1000)).rows[0].state, 'unknown')
})
await check('current context key covers connection definitions scaling and enums without touching credentials', () => {
  const data = input(), key = liveSnapshotComparisonKey(data.device, data.groups); assert(key)
  Object.defineProperty(data.device, 'apiKey', { get() { assert.fail('credentials must not be accessed') } }); assert.equal(liveSnapshotComparisonKey(data.device, data.groups), key)
  assert.notEqual(liveSnapshotComparisonKey({ ...device, ip: 'another.invalid' }, data.groups), key); assert.notEqual(liveSnapshotComparisonKey({ ...device, transport: 'rtu', serialPath: 'MOCK' }, data.groups), key)
  assert.notEqual(liveSnapshotComparisonKey(device, [{ ...data.groups[0], registers: data.groups[0].registers.map(point => ({ ...point, enumJson: '{"1":"changed"}' })) }]), key)
  assert.equal(liveSnapshotComparisonKey({}, data.groups), null)
  const json = liveSnapshotJson(freeze(data).snapshot); assert(!json.includes('"ip"')); assert(!json.includes('"apiKey"')); assert(!json.includes('scope":"source')); assert.equal(JSON.parse(json).version, 1)
})
await check('actual App capture binds source generation and failed captures preserve the previous observation', () => {
  const source = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node: ts.Node, match: (node: ts.Node) => boolean): ts.Node | undefined { if (match(node)) return node; return ts.forEachChild(node, child => find(child, match)) }
  const table = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'LiveTable')!, declaration = (name: string) => find(table, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration
  const run = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
  let dependency: unknown, saved: unknown; const memo = (fn: () => unknown, deps: unknown[]) => { if (deps[0] !== dependency) { dependency = deps[0]; saved = fn() }; return saved }
  const scope = (key: string) => run(declaration('snapshotComparisonScope').initializer!, { useMemo: memo, snapshotComparisonKey: key }) as symbol
  const context = (value: ReturnType<typeof input>) => run(declaration('snapshotComparisonKey').initializer!, { useMemo: (fn: () => unknown) => fn(), liveSnapshotComparisonKey, device: value.device, groups: value.groups }) as string
  const original = input(), originalKey = context(original), originalScope = scope(originalKey)
  const mutations: Array<(value: ReturnType<typeof input>) => void> = [value => { value.device = { ...value.device, ip: 'changed.invalid' } }, value => { value.groups[0].slaveId = 2 }, value => { value.groups[0].registers[0].dataType = 'uint32' }, value => { value.groups[0].registers[0].startAddress = 1 }, value => { value.groups[0].registers[0].factor = 1 }, value => { value.groups[0].registers[0].offset = 2 }, value => { value.groups[0].registers[0].enumJson = '{"1":"changed"}' }]
  for (const mutate of mutations) { const next = input(); mutate(next); assert.equal(next.device.id, original.device.id); assert.equal(next.groups[0].registers[0].id, original.groups[0].registers[0].id); const key = context(next); assert.notEqual(key, originalKey); const nextScope = scope(key); assert.equal(compareLiveSnapshots(freeze(original, originalScope), freeze(next, nextScope), nextScope).status, 'context'); scope(originalKey) }
  const first = scope('A'); assert.equal(scope('A'), first); scope('B'); assert.notEqual(scope('A'), first, 'observed A→B→A never revives old scope')
  const callback = find(table, node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onClick' && !!node.initializer?.getText(source).includes('captureLiveSnapshot')) as ts.JsxAttribute
  const expression = (callback.initializer as ts.JsxExpression).expression!, data = input(); let current: FrozenLiveObservation | null = null, errors = 0
  const click = (views = data.views) => run(expression, { captureLiveSnapshot, device: data.device, groups: data.groups, filteredPoints: { visibleIds: data.visibleIds }, views, pointStates: data.states, latest: data.latest, search: '', activeSource: '', pointFilter: 'all', alarmRulesReady: true, now: data.observedAt, Date: { now: () => data.capturedAt }, threshold: 5000, snapshotComparisonScope: first, setSnapshotCapture(value: FrozenLiveObservation) { current = value }, operation: { setNotice() { errors++ } }, t: (key: string) => key })()
  click(); const frozen = current! as FrozenLiveObservation; assert.equal(frozen.scope, first); assert(Object.isFrozen(frozen)); click(new Map()); assert.equal(current, frozen); assert.equal(errors, 1); click(); assert.notEqual(current, frozen); assert.equal(errors, 1); assert(source.text.includes('<LiveSnapshotComparison current={snapshotCapture} scope={snapshotComparisonScope}'))
})
await check('bilingual user flow preserves baseline across current close supports replacement and blocks stale contexts', () => {
  for (const english of [false, true]) {
    const a = freeze(), b = freeze(input([11, 20], 1000)), model = ui(a, english)
    try { model.baseline(); model.update(b); assert(model.html().includes(english ? 'Raw-word changes' : '原始字变化')); assert(model.html().includes('&lt;first&gt;')); assert(!model.html().includes('<first>')); assert(model.html().includes('PASS/FAIL')); assert(model.html().includes(english ? 'only the current single snapshot' : '当前单份快照'))
      model.update(null); assert(model.html().includes(a.snapshot.capturedAt)); model.update(b); const replacement = model.driver.one('button', p => String(p.children).includes(english ? 'Replace baseline' : '替换基线')); replacement.props.onClick(); model.driver.render(); assert(model.html().includes(english ? 'freeze the same scope again' : '重新冻结相同范围'))
      model.update(b, Symbol('new')); assert(model.html().includes(english ? 'Configuration or source changed' : '配置或来源已变化')); assert.equal(model.driver.one('button', p => String(p.children).includes(english ? 'Replace baseline' : '替换基线')).props.disabled, true)
      model.driver.one('button', p => p.children === (english ? 'Clear baseline' : '清除基线')).props.onClick(); model.driver.render(); assert(!model.html().includes(english ? 'Baseline UTC' : '基线UTC'))
    } finally { model.driver.dispose() }
  }
})
await check('ten thousand points remain paged and invalid UTC metadata cannot crash the view', () => {
  const a = freeze(input(Array(10000).fill(1))), b = freeze(input(Array(10000).fill(2), 1000)), model = ui(a)
  try { model.baseline(); model.update(b); assert.equal((model.html().match(/<tr>/g) ?? []).length, 21); model.driver.one('button', p => p.children === '下一页').props.onClick(); model.driver.render(); assert(model.html().includes('#21')); assert(!model.html().includes('· #1 ·'))
    const invalid = { ...b, snapshot: { ...b.snapshot, points: b.snapshot.points.map(point => ({ ...point, health: { ...point.health, timestampMs: 1e20 } })) } }; model.update(invalid); assert(model.html().includes('采样UTC'))
  } finally { model.driver.dispose() }
})
await check('empty and all-unavailable views preserve unknowns and filter toggles never hide them', () => {
  const empty = ui(null); assert.equal(empty.html(), ''); empty.driver.dispose()
  const a = freeze(), data = input([11, 20], 1000); for (const sample of Object.values(data.latest)) sample.quality = 'bad'; data.states = evaluateLivePoints(data.groups, data.views, data.latest, data.device, [], {}, data.observedAt, data.thresholdMs)
  const model = ui(a)
  try { model.baseline(); model.update(freeze(data)); assert(model.html().includes('不可比较')); assert.equal((model.html().match(/<tr>/g) ?? []).length, 3); assert(model.html().includes('样本缺失、异常、过期或批次未核实'))
    model.update(freeze(input([11, 20], 1000))); assert.equal((model.html().match(/<tr>/g) ?? []).length, 2); model.driver.one('input', p => p.type === 'checkbox').props.onChange({ target: { checked: false } }); model.driver.render(); assert.equal((model.html().match(/<tr>/g) ?? []).length, 3)
    const filters = input([11, 20], 1000); filters.filters.source = '1'; model.update(freeze(filters)); assert(model.html().includes('筛选条件或所选点位不同')); assert.equal((model.html().match(/<tr>/g) ?? []).length, 0)
  } finally { model.driver.dispose() }
})
await check('same-address slaves and partial multiword updates remain isolated at actual capture', () => {
  const multi = (step: number, a: number, b: number) => {
    const data = input([a], step, 'uint32'), second = input([b], step, 'uint32')
    const point = { ...second.groups[0].registers[0], id: 2, groupId: 20 }, group = { ...second.groups[0], id: 20, slaveId: 2, registers: [point] }; data.groups.push(group); data.visibleIds.add(2); data.views.set(2, second.views.get(1))
    for (const sample of Object.values(second.latest)) { const address = Object.values(second.latest).indexOf(sample); data.latest[sourceKey(1, 'holding-register', address, 2)] = { ...sample, slaveId: 2, batchId: 'slave2-' + step } }
    data.states = evaluateLivePoints(data.groups, data.views, data.latest, data.device, [], {}, data.observedAt, data.thresholdMs); return data
  }
  const a = freeze(multi(0, 65536, 123)), b = multi(1000, 65537, 123), result = changed(a, freeze(b)); assert.deepEqual(result.counts, { changed: 1, unchanged: 1, unknown: 0 }); assert.equal(result.rows[0].after.display.raw, '65537'); assert.equal(result.rows[1].after.display.raw, '123')
  delete b.latest[sourceKey(1, 'holding-register', 1, 2)]; b.states = evaluateLivePoints(b.groups, b.views, b.latest, b.device, [], {}, b.observedAt, b.thresholdMs); const partial = changed(a, freeze(b)); assert.equal(partial.rows[0].state, 'changed'); assert.equal(partial.rows[1].state, 'unknown'); assert.equal(partial.counts.unchanged, 0)
  for (const type of ['uint32-LE', 'uint64-LE']) assert.equal(changed(freeze(input([1], 0, type)), freeze(input([2], 1000, type))).rows[0].state, 'changed')
})
await check('unverified current scope never claims a confirmed configuration change or a usable baseline', () => {
  const current = freeze(input(), null)
  assert.equal(compareLiveSnapshots(null, current, null).status, 'unverified'); assert.equal(compareLiveSnapshots(current, freeze(input([11, 20], 1000)), token).status, 'unverified'); assert.equal(compareLiveSnapshots(null, freeze(), Symbol('changed')).status, 'context')
  for (const english of [false, true]) { const model = ui(current, english, null); try { assert.equal(model.driver.one('button', props => String(props.children).includes(english ? 'snapshot as baseline' : '设为基线')).props.disabled, true); assert(model.html().includes(english ? 'Source/configuration unverified' : '来源/配置未核实')); assert(!model.html().includes(english ? 'Configuration or source changed' : '配置或来源已变化')); assert.equal((model.html().match(/<tr>/g) ?? []).length, 0) } finally { model.driver.dispose() } }
})
await check('actual page channel reconnect cannot validate cached or partial words and later frames cannot mutate freezes', () => {
  const parse = (name: string) => ts.createSourceFile(name, fs.readFileSync(new URL(name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const source = parse('../apps/web/src/App.tsx'), fixtureSource = parse('./test-device-connection-view.ts')
  function find(node: ts.Node, match: (node: ts.Node) => boolean): ts.Node | undefined { if (match(node)) return node; return ts.forEachChild(node, child => find(child, match)) }
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), compile('return (' + node.getText(source) + ')'))(...Object.values(env))
  const effect = find(source, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && !!node.arguments[0]?.getText(source).includes('const HEARTBEAT_MS')) as ts.CallExpression
  // Reuse only the isolated socket/clock fixture, not that suite's tests or App mount.
  const fixture = find(fixtureSource, node => ts.isFunctionDeclaration(node) && node.name?.text === 'fixture')!
  const f = new Function('assert', 'evaluate', 'effect', 'connected', 'RealtimeFallbackRead', 'sourceKey', compile(fixture.getText(fixtureSource) + '\nreturn fixture()'))(assert, evaluate, effect, {}, RealtimeFallbackRead, sourceKey)
  const buildViews = new Function('sourceSample', 'sameResponseBatch', 'displayNumber', 'physicalValue', ...Object.keys(codec), compile(['areaForFunctionCode', 'enumLabelOf', 'buildRegViews'].map(name => find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)).join('\n') + '\nreturn buildRegViews'))(sourceSample, sameResponseBatch, displayNumber, physicalValue, ...Object.values(codec))
  const data = input([65536], 0, 'uint32'), observe = () => { const views = buildViews(data.groups, f.state.latest, 1); return freeze({ ...data, views, latest: f.state.latest, states: evaluateLivePoints(data.groups, views, f.state.latest, data.device, [], f.state.errors, f.now, 5000), observedAt: f.now, capturedAt: f.now }) }
  let model: ReturnType<typeof ui> | undefined
  try {
    const first = f.sockets[0]; first.open(); first.message({ type: 'latest', data: data.latest }); const a = observe(); model = ui(a); model.baseline()
    first.close(); f.advance(500); assert.equal(changed(a, observe()).rows[0].reason, 'not-new')
    f.reconnect(); const next = f.sockets[1]; next.open(); next.message({ type: 'device/status', objectId: 1, connected: true }); assert.equal(changed(a, observe()).rows[0].reason, 'not-new', 'socket and device status alone cannot create new sample evidence')
    const fresh = input([65537], 1000, 'uint32'); first.message({ type: 'latest', data: fresh.latest }); assert.equal(changed(a, observe()).rows[0].reason, 'not-new', 'late old socket must be ignored')
    f.advance(500); const points = Object.values(fresh.latest).map((sample, address) => ({ ...sample, address, objectId: 1, area: 'holding-register' }))
    next.message({ type: 'poller/result', points: points.slice(0, 1) }); assert.equal(changed(a, observe()).rows[0].state, 'unknown', 'new high word plus cached low word cannot be compared')
    next.message({ type: 'poller/result', points: points.slice(1) }); const b = observe(); assert.equal(changed(a, b).rows[0].state, 'changed'); model.update(b)
    const jsonA = liveSnapshotJson(a.snapshot), jsonB = liveSnapshotJson(b.snapshot), html = model.html()
    f.advance(1000); next.message({ type: 'latest', data: input([65538], 2000, 'uint32').latest }); assert.equal(liveSnapshotJson(a.snapshot), jsonA); assert.equal(liveSnapshotJson(b.snapshot), jsonB); assert.equal(model.html(), html); assert.equal(changed(a, b).rows[0].after.display.raw, '65537'); assert.equal(observe().snapshot.points[0].display.raw, '65538')
    f.advance(6000); model.update(observe()); assert.equal(changed(a, observe()).rows[0].state, 'unknown'); assert(model.html().includes('样本缺失、异常、过期或批次未核实')); assert(!model.html().includes('<td>原始字未变化'))
  } finally { model?.driver.dispose(); f.close() }
})
for (const english of [false, true]) for (const kind of ['normal', 'one-future', 'observed-backward', 'captured-backward', 'same-ms', 'unchanged'] as const) await check('frozen age/clock/baseline/export ' + english + '/' + kind, async () => {
  const baseInput = input([10], 0, 'uint32'), nextInput = input([kind === 'unchanged' ? 10 : 11], kind === 'same-ms' ? 0 : 1000, 'uint32', 'current-batch')
  baseInput.observedAt = origin + 2000; baseInput.capturedAt = origin + 3000
  nextInput.observedAt = origin + 3000; nextInput.capturedAt = origin + 4000
  if (kind === 'one-future') Object.values(nextInput.latest)[0].timestampMs = origin + 120000
  if (kind === 'observed-backward') nextInput.observedAt = origin - 2000
  if (kind === 'captured-backward') nextInput.capturedAt = origin - 1000
  if (kind === 'same-ms') { baseInput.observedAt = baseInput.capturedAt = nextInput.observedAt = nextInput.capturedAt = origin }
  for (const data of [baseInput, nextInput]) {
    for (const [index, sample] of Object.values(data.latest).entries()) {
      const time = sample.timestampMs!
      sample.timestamp = index === 0 ? new Date(time + 8 * 3600000).toISOString().slice(0, -1).replace(/(\.\d{3})$/, part => part + '000456') + '+08:00' : new Date(time).toISOString()
      assert.equal(Date.parse(sample.timestamp), time)
    }
    data.states = evaluateLivePoints(data.groups, data.views, data.latest, data.device, [], {}, data.observedAt, data.thresholdMs)
  }
  const base = freeze(baseInput), current = freeze(nextInput), jsonA = liveSnapshotJson(base.snapshot), jsonB = liveSnapshotJson(current.snapshot)
  const times = (snapshot: typeof current.snapshot) => snapshot.points.flatMap(point => point.words.map(word => [word.sample?.timestamp, word.sample?.timestampMs]))
  const originalTimes = JSON.stringify([times(base.snapshot), times(current.snapshot)]), expectedAge = kind === 'same-ms' ? 0 : kind === 'one-future' || kind === 'observed-backward' ? null : 2
  assert.equal(current.snapshot.points[0].health.ageSeconds, expectedAge)
  const comparison = changed(base, current)
  if (kind === 'captured-backward') assert.equal(comparison.status, 'time')
  else { assert.equal(comparison.status, 'ready'); assert.equal(comparison.rows[0].state, expectedAge === null ? 'unknown' : kind === 'unchanged' ? 'unchanged' : 'changed'); if (expectedAge === null) assert.equal(comparison.rows[0].reason, 'samples') }
  const model = ui(base, english); model.baseline(); model.update(current)
  if (kind === 'captured-backward') assert(model.html().includes(english ? 'Snapshot times are invalid or reversed' : '快照时间倒退或无效'))
  if (expectedAge === null) assert(model.html().includes(english ? 'Missing, invalid, stale or unverified-batch samples' : '样本缺失、异常、过期或批次未核实'))
  let blob: Blob | undefined, attempts = 0, removed = 0, failed = false, filename = ''
  const queued: Array<() => void> = [], revoked: string[] = []
  const urls = { createObjectURL(value: Blob) { blob = value; return 'blob:age-export-' + ++attempts }, revokeObjectURL(value: string) { revoked.push(value) } }
  const doc = { createElement() { const link = { href: '', download: '', click() { filename = link.download; if (failed) throw new Error('synthetic local failure') }, remove() { removed++ } }; return link }, body: { appendChild() {} } } as any
  const exportCurrent = (snapshot: typeof current.snapshot) => downloadLiveSnapshot(snapshot, doc, urls, fn => queued.push(fn))
  const panel = hookDriver('LiveSnapshotPanel.tsx', 'LiveSnapshotPanel', { downloadLiveSnapshot: exportCurrent }, { snapshot: current.snapshot, english, close() {} })
  const readAge = () => { const html = renderToStaticMarkup(panel.tree), row = html.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)![1], cells = [...row.matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)]; assert(html.includes(english ? 'Age at freeze (s)' : '冻结时年龄（秒）')); assert(html.includes(english ? 'does not increase after freezing' : '冻结后不会递增')); assert.equal(cells[3][1].split('<')[0], expectedAge === null ? english ? 'Unknown' : '未知' : String(expectedAge)); return html }
  const download = () => { panel.one('button', props => props.children === (english ? 'Download JSON' : '下载 JSON')).props.onClick(); panel.render() }
  const clock = Date.now
  const exportedNames = new Set<string>()
  try {
    Date.now = () => origin + 86400000; const html = readAge(), compared = model.html()
    Date.now = () => origin - 86400000; panel.render(); model.driver.render(); assert.equal(readAge(), html); assert.equal(model.html(), compared); assert.deepEqual(changed(base, current), comparison)
    for (const [attempt, fail] of [false, true, false].entries()) {
      Date.now = () => origin + (attempt % 2 ? -86400000 : 86400000)
      failed = fail; download(); readAge(); exportedNames.add(filename); assert.equal(filename, liveSnapshotFilename(current.snapshot)); assert.deepEqual(JSON.parse(await blob!.text()), current.snapshot)
      if (fail) assert(renderToStaticMarkup(panel.tree).includes(english ? 'Local download could not be completed or confirmed' : '本地下载未完成'))
      else assert(!renderToStaticMarkup(panel.tree).includes(english ? 'Local download could not be completed or confirmed' : '本地下载未完成'))
      queued.shift()!(); assert.equal(revoked.length, attempts); assert.equal(removed, attempts)
      assert.equal(liveSnapshotJson(base.snapshot), jsonA); assert.equal(liveSnapshotJson(current.snapshot), jsonB); assert.equal(JSON.stringify([times(base.snapshot), times(current.snapshot)]), originalTimes)
      assert.equal(model.html(), compared, 'export, including a failed download, cannot replace or clear the baseline')
    }
    assert.equal(attempts, 3); assert.equal(exportedNames.size, 1, 'forward/backward wall clocks cannot rename the frozen export'); assert.equal(queued.length, 0); assert.equal(current.snapshot.automaticEligible, false)
  } finally { Date.now = clock; panel.dispose(); model.driver.dispose() }
})
for (const english of [false, true]) await check('post-click cleanup failure retains age/baseline and reports uncertain download ' + english, () => {
  const base = freeze(input([10], 0, 'uint32')), current = freeze(input([11], 1000, 'uint32')), jsonA = liveSnapshotJson(base.snapshot), jsonB = liveSnapshotJson(current.snapshot)
  const model = ui(base, english); model.baseline(); model.update(current); const compared = model.html()
  let clicks = 0, removed = 0, revoked = 0
  const queued: Array<() => void> = [], doc = { createElement() { return { href: '', download: '', click() { clicks++ }, remove() { removed++; throw new Error('synthetic cleanup after accepted click') } } }, body: { appendChild() {} } } as any
  const adapter = (snapshot: typeof current.snapshot) => downloadLiveSnapshot(snapshot, doc, { createObjectURL: () => 'blob:cleanup-test', revokeObjectURL() { revoked++ } }, fn => queued.push(fn))
  const panel = hookDriver('LiveSnapshotPanel.tsx', 'LiveSnapshotPanel', { downloadLiveSnapshot: adapter }, { snapshot: current.snapshot, english, close() {} })
  try {
    panel.one('button', props => props.children === (english ? 'Download JSON' : '下载 JSON')).props.onClick(); panel.render()
    assert.equal(clicks, 1); assert.equal(removed, 1); const html = renderToStaticMarkup(panel.tree)
    const cells = [...html.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)![1].matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)]; assert.equal(cells[3][1], '0', 'post-click cleanup failure cannot change frozen age')
    assert(html.includes(english ? 'could not be completed or confirmed' : '未完成或无法确认'), 'an accepted download click followed by cleanup failure cannot be called definitely incomplete')
    assert(html.includes(english ? 'check browser downloads before retrying' : '先核对浏览器下载记录再重试'))
    assert(html.includes(english ? 'Age at freeze (s)' : '冻结时年龄（秒）')); assert.equal(model.html(), compared)
    assert.equal(liveSnapshotJson(base.snapshot), jsonA); assert.equal(liveSnapshotJson(current.snapshot), jsonB)
    assert.equal(queued.length, 1); queued.shift()!(); assert.equal(revoked, 1)
  } finally { panel.dispose(); model.driver.dispose() }
})
console.log('SNAPSHOT COMPARE TEST OK: ' + passed + ' pure/source/UI groups; synthetic snapshots only, no requests, writes, browser storage, downloaded files, database, hardware or models')
