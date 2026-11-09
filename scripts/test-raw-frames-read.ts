import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply } from '../packages/poller/src/index.ts'
import { ModbusDiagnostics } from '../packages/modbus/src/diagnostics.ts'
import { communicationScope } from '../apps/web/src/communication-summary.ts'
import { clampFrameLimit, parseRawFrames, RawFramesRead } from '../apps/web/src/raw-frames-read.ts'
import { RawFramesStatus } from '../apps/web/src/RawFramesStatus.tsx'

const device = { id: 1, transport: 'tcp' }, serial = { id: 2, transport: 'rtu', serialPath: 'COM_MOCK' }, scope = communicationScope(device)
let engine: any, effects = 0
const tcp = new ModbusDiagnostics('tcp', 2000, { deviceId: 1, channelKey: 'tcp:1' }), rtu = new ModbusDiagnostics('rtu', 2000, { channelKey: 'rtu:COM_MOCK' })
tcp.recordFrame('tx', Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1])); tcp.recordFrame('rx', Buffer.from([0, 1, 0, 0, 0, 5, 1, 3, 2, 0, 0]))
rtu.recordFrame('tx', Buffer.from([1, 3, 0, 0])); rtu.recordFrame('rx', Buffer.from([2, 3, 0, 1])); rtu.recordFrame('rx', Buffer.from([1, 0x83, 2]))
apply({ on() {}, provide(_name: string, value: any) { engine = value }, config: { getObject: (id: number) => [device, serial].find(value => value.id === id), listGroups: () => [{ slaveId: 1 }] }, modbus: { createDriver() { effects++; throw new Error('no driver creation') } }, store: { write() { effects++ } }, emit() { effects++ } } as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
const driver = (diag: ModbusDiagnostics) => ({ getFrames: (limit: number) => diag.getFrames(limit), connect() { effects++ }, clearDiagnostics() { effects++ }, readHoldingRegisters() { effects++ } })
engine.drivers.set('tcp:1', driver(tcp)); engine.drivers.set('rtu:COM_MOCK', driver(rtu))
const before = JSON.stringify([tcp.snapshot(), rtu.snapshot()]), body = JSON.parse(JSON.stringify(engine.getDeviceFrames(1, 200))), serialBody = JSON.parse(JSON.stringify(engine.getDeviceFrames(2, 200)))
const parsed = parseRawFrames(body, scope, 200), serialParsed = parseRawFrames(serialBody, communicationScope(serial), 200)
assert.equal(parsed.frames.length, 2); assert(parsed.frames.every(frame => frame.sourceMetadataMatched)); assert.deepEqual(serialParsed.frames.map(frame => frame.slaveId), [1, 1]); assert.equal(serialParsed.frames[1].exceptionCode, 2); assert.equal(effects, 0); assert.equal(JSON.stringify([tcp.snapshot(), rtu.snapshot()]), before)
assert(Object.isFrozen(parsed)); assert(Object.isFrozen(parsed.frames)); assert(Object.isFrozen(parsed.frames[0])); const frozen = parsed.frames[0].hex; body[0].hex = 'mutated'; assert.equal(parsed.frames[0].hex, frozen)
const raw = JSON.parse(JSON.stringify(engine.getDeviceFrames(1, 200))), legacy = [{ ...raw[0], channelKey: undefined, deviceId: undefined }]; assert.equal(parseRawFrames(legacy, scope, 200).frames[0].sourceMetadataMatched, false)
for (const value of [null, {}, [...raw, raw[0]], raw.map((row: any) => ({ ...row, id: 1 })), [{ ...raw[0], direction: 'other' }], [{ ...raw[0], timestamp: 'not a date' }], [{ ...raw[0], byteLength: raw[0].byteLength + 1 }], [{ ...raw[0], hex: 'GG' }], [{ ...raw[0], deviceId: 2 }], [{ ...raw[0], channelKey: 'tcp:2' }], [{ ...raw[0], transport: 'rtu' }], [{ ...raw[0], slaveId: 256 }], [{ ...raw[0], functionCode: -1 }], [{ ...raw[0], isException: 0 }]]) assert.throws(() => parseRawFrames(value, scope, 200))
assert.throws(() => parseRawFrames(raw, scope, 1)); assert.throws(() => parseRawFrames([], scope, 0)); assert.equal(parseRawFrames([], scope, 200).frames.length, 0)
assert.deepEqual([0, NaN, -3, 2001, 2.8].map(clampFrameLimit), [200, 200, 1, 2000, 2])
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const reader = new RawFramesRead(device, 200), slow = deferred(); let calls = 0, notifications = 0
const stop = reader.subscribe(() => notifications++)
const pending = reader.refresh(async (url, signal) => { calls++; assert.equal(url, '/api/monitor_objects/1/frames?limit=200'); assert(signal instanceof AbortSignal); return slow.promise })
await Promise.resolve()
for (let tick = 0; tick < 6; tick++) await reader.refresh(async () => { calls++; return raw })
assert.equal(calls, 1, 'repeated interval/manual refresh while slow must not supersede or overlap the active read')
slow.resolve(raw); await pending; assert.equal(reader.snapshot().phase, 'ready'); assert.equal(reader.snapshot().value!.frames.length, 2, 'a slow response is accepted while polling remains active')
await reader.refresh(async () => { throw new Error('PRIVATE request detail') }); assert.equal(reader.snapshot().error, 'request'); assert.equal(reader.snapshot().value!.frames.length, 2); assert(!JSON.stringify(reader.snapshot()).includes('PRIVATE'))
await reader.refresh(async () => [{ ...raw[0], deviceId: 99 }]); assert.equal(reader.snapshot().error, 'invalid'); assert.equal(reader.snapshot().value!.frames.length, 2)
let timedSignal!: AbortSignal; const timeout = deferred()
await reader.refresh(async (_url, signal) => { timedSignal = signal; return timeout.promise }, 5); assert.equal(reader.snapshot().error, 'timeout'); assert(timedSignal.aborted)
await reader.refresh(async () => []); timeout.resolve(raw); await Promise.resolve(); assert.equal(reader.snapshot().phase, 'ready'); assert.equal(reader.snapshot().value!.frames.length, 0)
await reader.refresh(async () => raw)
const late = deferred(), old = reader.refresh(async () => late.promise); await Promise.resolve(); reader.cancel(); const paused = reader.snapshot(); assert.equal(paused.phase, 'idle'); assert.equal(paused.value!.frames.length, 2)
late.resolve([]); await old; assert.equal(reader.snapshot(), paused, 'pause freezes the display even when the provider ignores abort')
const stale = deferred(), staleTask = reader.refresh(async () => stale.promise); await Promise.resolve(); reader.cancel(); const fresh = deferred(), freshTask = reader.refresh(async () => fresh.promise); await Promise.resolve(); stale.reject(new Error('obsolete error')); await staleTask
assert.equal(reader.snapshot().phase, 'loading'); let duplicate = 0; await reader.refresh(async () => { duplicate++; return raw }); assert.equal(duplicate, 0, 'obsolete finalizer cannot unlock the newer read'); fresh.resolve([]); await freshTask; assert.equal(reader.snapshot().phase, 'ready')
const other = new RawFramesRead({ ...device, id: 3 }, 20); await other.refresh(async () => [{ ...raw[0], deviceId: 3, channelKey: 'tcp:3' }]); assert.equal(other.snapshot().value!.frames.length, 1); assert.equal(reader.snapshot().value!.frames.length, 0)
let invalidCalls = 0
for (const invalid of [new RawFramesRead(null, 200), new RawFramesRead({ id: 1, transport: 'future' }, 200), new RawFramesRead(device, 0)]) await invalid.refresh(async () => { invalidCalls++; return raw })
assert.equal(invalidCalls, 0, 'invalid context must not issue a request, including one whose error would be handled')
stop(); const n = notifications; await reader.refresh(async () => raw); assert.equal(notifications, n)
for (const english of [false, true]) {
  const render = (state: any, paused = false) => renderToStaticMarkup(createElement(RawFramesStatus, { state, paused, english }))
  assert(render({ phase: 'loading' }).includes(english ? 'do not overlap' : '不会叠加'))
  const error = render({ phase: 'error', error: 'timeout', value: parsed }); assert(error.includes(english ? 'Previous captures' : '保留上次显示')); assert(error.includes(english ? 'unverified' : '未核实'))
  assert(render({ phase: 'idle', value: parsed }, true).includes(english ? 'acquisition continues' : '设备采集继续'))
  assert(render({ phase: 'ready', value: parseRawFrames([], scope, 200) }).includes(english ? 'no captures' : '没有返回捕获记录'))
  assert(!render({ phase: 'error', error: 'request' }).includes(english ? 'no captures' : '没有返回捕获记录'))
  assert(render({ phase: 'ready', value: parseRawFrames(legacy, scope, 1) }).includes(english ? 'legacy captures' : '部分旧记录'))
  assert(render({ phase: 'ready', value: parseRawFrames(raw, scope, 2) }).includes(english ? 'Display limit reached' : '达到显示上限'))
}
// Evaluate the actual view expressions and callbacks without mounting App or opening a connection.
const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const view = appSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RawDataView')!
assert(view, 'raw capture view exists')
const nodes: ts.Node[] = []; const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit) }; visit(view)
const variable = (name: string) => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(appSource) === name) as ts.VariableDeclaration
const evaluate = (node: ts.Node, context: Record<string, unknown>) => Function(...Object.keys(context), ts.transpile(`const result = (${node.getText(appSource)}); return result`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }))(...Object.values(context))
const status = nodes.find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(appSource) === 'RawFramesStatus') as ts.JsxSelfClosingElement
const focusAttribute = status?.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(appSource) === 'exceptionFocus') as ts.JsxAttribute
assert(focusAttribute?.initializer && ts.isJsxExpression(focusAttribute.initializer), 'raw view must connect the local exception focus control')
const focusExpression = (focusAttribute.initializer as ts.JsxExpression).expression!
const map = nodes.find(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') as ts.CallExpression
assert.equal((map.expression as ts.PropertyAccessExpression).expression.getText(appSource), 'visibleFrames', 'actual rendered rows must follow the focus, not merely its count')
assert(nodes.some(node => ts.isCallExpression(node) && node.expression.getText(appSource) === 'useEffect' && /setExceptionReader\(null\)/.test(node.arguments[0].getText(appSource)) && node.arguments[1]?.getText(appSource) === '[reader]'), 'release the old reader on source/limit change')
const captures = new ModbusDiagnostics('tcp', 2000, { deviceId: 1, channelKey: 'tcp:1' })
captures.recordFrame('tx', Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1]))
captures.recordFrame('rx', Buffer.from([0, 1, 0, 0, 0, 3, 1, 0x83, 2]))
captures.recordFrame('rx', Buffer.from([0, 1, 0, 0, 0, 5, 1, 3, 2, 0, 0]))
const mixed = parseRawFrames(captures.getFrames(200), scope, 200), original = JSON.stringify(mixed)
let exceptionReader: RawFramesRead | null = null
const focus = (current: RawFramesRead, frames = mixed.frames) => {
  const onlyExceptions = evaluate(variable('onlyExceptions').initializer!, { exceptionReader, reader: current })
  const visibleFrames = evaluate(variable('visibleFrames').initializer!, { onlyExceptions, frames })
  const control = evaluate(focusExpression, { onlyExceptions, visibleFrames, reader: current, setExceptionReader: (value: RawFramesRead | null) => { exceptionReader = value } })
  return { control, visibleFrames }
}
const walkElements = (node: any): any[] => Array.isArray(node) ? node.flatMap(walkElements) : node && typeof node === 'object' && node.props ? [node, ...walkElements(node.props.children)] : []
assert.equal(focus(reader).visibleFrames, mixed.frames, 'all view retains the exact source sequence')
for (const english of [false, true]) {
  exceptionReader = null
  const initial = focus(reader), tree = RawFramesStatus({ state: { phase: 'ready', value: mixed }, paused: false, english, exceptionFocus: initial.control })
  const checkbox = walkElements(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert(checkbox); assert(walkElements(tree).some(node => node.type === 'label' && walkElements(node.props.children).includes(checkbox)), 'native keyboard control has a visible label')
  checkbox.props.onChange({ target: { checked: true } })
  const filtered = focus(reader); assert.equal(filtered.control.active, true)
  assert.deepEqual(filtered.visibleFrames, mixed.frames.filter(frame => frame.isException)); assert.equal(filtered.visibleFrames.length, 1)
  const render = (value: typeof mixed, shown: number, phase: 'ready' | 'error' = 'ready', paused = false) => renderToStaticMarkup(createElement(RawFramesStatus, { state: { phase, error: phase === 'error' ? 'request' : undefined, value }, paused, english, exceptionFocus: { ...filtered.control, shown } }))
  const html = render(mixed, 1); assert(html.includes('1/3')); assert(html.includes(english ? 'timeouts/connection errors' : '超时/连接错误'))
  assert(render(parsed, 0).includes(english ? 'No matches' : '当前快照未匹配'))
  const empty = render(parseRawFrames([], scope, 200), 0); assert(!empty.includes(english ? 'No matches' : '当前快照未匹配')); assert(empty.includes(english ? 'no captures' : '没有返回捕获记录'))
  assert(render(mixed, 1, 'error', true).includes(english ? 'Previous captures' : '保留上次显示'))
  const legacyException = parseRawFrames([{ ...captures.getFrames(200).find(frame => frame.isException)!, channelKey: undefined, deviceId: undefined }], scope, 200)
  assert.equal(focus(reader, legacyException.frames).visibleFrames.length, 1); assert(render(legacyException, 1).includes(english ? 'legacy captures' : '部分旧记录'))
  const activeTree = RawFramesStatus({ state: { phase: 'ready', value: mixed }, paused: false, english, exceptionFocus: filtered.control })
  const showAll = walkElements(activeTree).find(node => node.type === 'button'); assert.equal(showAll.props.type, 'button'); showAll.props.onClick(); assert.equal(focus(reader).visibleFrames, mixed.frames)
  filtered.control.change(true)
  for (const next of [other, new RawFramesRead(device, 20), new RawFramesRead({ ...device, ip: 'mock-new-source' }, 200)]) {
    assert.equal(focus(next).control.active, false, 'source or limit replacement defaults to all')
    filtered.control.change(true); assert.equal(focus(next).visibleFrames, mixed.frames, 'late old-source callback cannot filter the new source')
  }
  filtered.control.change(false); assert.equal(focus(reader).visibleFrames, mixed.frames)
}
assert.equal(JSON.stringify(mixed), original); assert.equal(effects, 0, 'local controls never connect, poll, clear or write')
const bounded = Object.freeze(Array.from({ length: 2000 }, (_, index) => Object.freeze({ ...mixed.frames[0], id: index + 1, isException: index % 4 === 0 })))
exceptionReader = reader
assert.deepEqual(focus(reader, bounded).visibleFrames.map((frame: any) => frame.id), bounded.filter(frame => frame.isException).map(frame => frame.id), 'maximum-size snapshot preserves all matching records in source order')
assert.equal(focus(reader, bounded).visibleFrames.length, 500)
console.log('RAW FRAMES FOCUS OK: actual view selection/map and checkbox/show-all callbacks, bilingual counts and distinct empty/no-match, legacy/error/pause, source/limit/late-control isolation; local snapshot only')
console.log('RAW FRAMES READ OK: producer/poller memory getters and RTU filtering, slow-response acceptance, single-flight, timeout/recovery, pause/late success/error/finalizer isolation, source/limit ownership, legacy metadata, strict immutable captures and bilingual status SSR; no real data, files, network, hardware, model or DOM automation')
