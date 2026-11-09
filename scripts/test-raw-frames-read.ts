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

const device = { id: 1, transport: 'tcp' }, serial = { id: 2, transport: 'rtu', serialPath: 'COM_MOCK' }, sharedSerial = { ...serial, id: 3 }, scope = communicationScope(device)
let engine: any, effects = 0
const tcp = new ModbusDiagnostics('tcp', 2000, { deviceId: 1, channelKey: 'tcp:1' }), rtu = new ModbusDiagnostics('rtu', 2000, { channelKey: 'rtu:COM_MOCK' })
tcp.recordFrame('tx', Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1])); tcp.recordFrame('rx', Buffer.from([0, 1, 0, 0, 0, 5, 1, 3, 2, 0, 0]))
rtu.recordFrame('tx', Buffer.from([1, 3, 0, 0])); rtu.recordFrame('rx', Buffer.from([2, 3, 0, 1])); rtu.recordFrame('rx', Buffer.from([1, 0x83, 2]))
apply({ on() {}, provide(_name: string, value: any) { engine = value }, config: { getObject: (id: number) => [device, serial, sharedSerial].find(value => value.id === id), listGroups: () => [{ slaveId: 1 }] }, modbus: { createDriver() { effects++; throw new Error('no driver creation') } }, store: { write() { effects++ } }, emit() { effects++ } } as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
const driver = (diag: ModbusDiagnostics) => ({ getFrames: (limit: number) => diag.getFrames(limit), connect() { effects++ }, clearDiagnostics() { effects++ }, readHoldingRegisters() { effects++ } })
engine.drivers.set('tcp:1', driver(tcp)); engine.drivers.set('rtu:COM_MOCK', driver(rtu))
for (const target of [device, serial]) engine.driverBindings.set(engine.drivers.get(engine.driverKey(target)), engine.connectionSignature(target))
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
const other = new RawFramesRead({ ...device, id: 4 }, 20); await other.refresh(async () => [{ ...raw[0], deviceId: 4, channelKey: 'tcp:4' }]); assert.equal(other.snapshot().value!.frames.length, 1); assert.equal(reader.snapshot().value!.frames.length, 0)
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
assert.equal((map.expression as ts.PropertyAccessExpression).expression.getText(appSource), 'pageFrames', 'actual rendered rows must follow the selected segment')
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
// Capture markers describe observed byte chunks, not validated protocol responses.
const localFormatter = appSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'formatLocalTs')!
const renderRow = evaluate(map.arguments[0], { React: { createElement }, formatLocalTs: evaluate(localFormatter, {}), dir: evaluate(variable('dir').initializer!, {}) })
const currentPageOwner = {}, segment = (frames: readonly unknown[], capturePage: { owner: object; index: number } | null) => {
  const visibleFrames = frames, pageOwner = currentPageOwner
  const pageIndex = evaluate(variable('pageIndex').initializer!, { visibleFrames, capturePage, pageOwner })
  const pageEnd = evaluate(variable('pageEnd').initializer!, { visibleFrames, pageIndex }), pageStart = evaluate(variable('pageStart').initializer!, { pageEnd })
  const pageFrames = evaluate(variable('pageFrames').initializer!, { visibleFrames, pageStart, pageEnd })
  return { pageFrames, pageStart, pageEnd, pageIndex }
}
for (const count of [0, 1, 19, 20, 21, 1999, 2000]) {
  const frames = bounded.slice(0, count), blocks: unknown[][] = []
  for (let index = 0; index < Math.max(1, Math.ceil(count / 20)); index++) {
    const page = segment(frames, { owner: currentPageOwner, index })
    assert(page.pageFrames.length <= 20); assert.equal(page.pageEnd - page.pageStart, page.pageFrames.length); blocks.push(page.pageFrames)
  }
  assert.deepEqual(blocks.reverse().flat(), frames, 'every record remains reachable exactly once in a paused snapshot, in returned order')
  assert.deepEqual(segment(frames, null).pageFrames, frames.slice(-20))
  assert.equal(segment(frames, { owner: currentPageOwner, index: -10 }).pageIndex, 0)
  assert.equal(segment(frames, { owner: currentPageOwner, index: 99999 }).pageIndex, Math.max(0, Math.ceil(count / 20) - 1))
  assert.equal(segment(frames, { owner: {}, index: 3 }).pageIndex, 0, 'source/limit/filter owner changes reset the segment')
}
let pageWrites: unknown[] = []
const pageMounted = { current: true }, pageOwnerRef = { current: currentPageOwner }
const turnPage = evaluate(variable('showPage').initializer!, { mounted: pageMounted, pageOwnerRef, pageOwner: currentPageOwner, setCapturePage: (value: unknown) => pageWrites.push(value) })
turnPage(1); assert.deepEqual(pageWrites, [{ owner: currentPageOwner, index: 1 }])
pageOwnerRef.current = {}; turnPage(2); assert.equal(pageWrites.length, 1, 'late old-source/filter callbacks cannot replace current segment selection')
pageOwnerRef.current = currentPageOwner; pageMounted.current = false; turnPage(2); assert.equal(pageWrites.length, 1, 'unmounted controls cannot write state')
console.log('RAW CAPTURE SEGMENT OK: 7 boundary counts through 2000, complete paused traversal, last20 default, clamped shrink, owner reset and stale/unmounted controls; snapshots unchanged')
let longRows = 0, damagedReads = 0
for (const transport of ['tcp', 'rtu'] as const) {
  const target = transport === 'tcp' ? device : serial, targetScope = communicationScope(target), key = engine.driverKey(target), previousDriver = engine.drivers.get(key)
  try {
    for (const size of [256, 65536, 262144]) {
      const data = Buffer.from(Array.from({ length: size }, (_, index) => index % 256))
      data.set(transport === 'tcp' ? [0, 1, 0, 0, 0, 3, 1, 3] : [1, 3]); data.set([0, 255, 126], size - 3)
      const originalHex = data.toString('hex').toUpperCase(), diag = new ModbusDiagnostics(transport, 3, transport === 'tcp' ? { deviceId: 1, channelKey: key } : { channelKey: key })
      for (const direction of ['tx', 'rx'] as const) diag.recordFrame(direction, data)
      data.fill(0); assert(diag.getFrames().every(frame => frame.hex === originalHex), 'capture owns its bytes even if the source buffer is reused')
      const mockDriver = driver(diag); engine.drivers.set(key, mockDriver); engine.driverBindings.set(mockDriver, engine.connectionSignature(target))
      const source = JSON.parse(JSON.stringify(engine.getDeviceFrames(target.id, 200))), original = JSON.stringify(source), snapshot = parseRawFrames(source, targetScope, 200)
      for (const frame of snapshot.frames) {
        assert.equal(frame.hex, originalHex); assert.equal(frame.byteLength, size)
        const row = renderRow(frame), bytes = row.props.children.at(-1).props.children, html = renderToStaticMarkup(row)
        assert.equal(typeof bytes, 'string'); assert.equal(bytes.replace(/\s/g, ''), originalHex, 'all rendered byte text reconstructs the complete received capture, including zero and high bytes')
        assert.equal(bytes.length, size * 3 - 1); assert(html.includes(bytes)); assert(html.includes(size + 'B')); assert(!bytes.includes('…') && !bytes.includes('...'))
        assert.equal(Buffer.from(bytes.replace(/\s/g, ''), 'hex').length, size); longRows++
      }
      const read = new RawFramesRead(target, 200)
      await read.refresh(async () => source); const retained = read.snapshot().value
      for (const hex of [source[1].hex.slice(0, -2), source[1].hex.slice(0, -1), source[1].hex.slice(0, -3) + '...']) {
        await read.refresh(async () => [source[0], { ...source[1], hex }]); assert.equal(read.snapshot().phase, 'error'); assert.equal(read.snapshot().error, 'invalid'); assert.equal(read.snapshot().value, retained)
        for (const english of [false, true]) {
          const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: read.snapshot(), paused: false, english }))
          assert(html.includes(english ? 'could not be verified' : '无法核实')); assert(html.includes(english ? 'Previous captures' : '保留上次显示'))
          assert(!html.includes(english ? 'This read returned no captures' : '本次读取没有返回捕获记录'))
        }
        damagedReads++
      }
      await read.refresh(async () => source); assert.equal(read.snapshot().phase, 'ready'); read.cancel()
      assert.equal(JSON.stringify(source), original); assert(diag.getFrames().every(frame => frame.hex === originalHex))
    }
    const boundedCapture = new ModbusDiagnostics(transport, 3, transport === 'tcp' ? { deviceId: 1, channelKey: key } : { channelKey: key })
    for (let index = 0; index < 5; index++) boundedCapture.recordFrame('rx', Uint8Array.from(transport === 'tcp' ? [0, index, 0, 0, 0, 2, 1, 3] : [1, 3, index]))
    const boundedDriver = driver(boundedCapture); engine.drivers.set(key, boundedDriver); engine.driverBindings.set(boundedDriver, engine.connectionSignature(target))
    assert.deepEqual(boundedCapture.getFrames(2000).map(frame => frame.id), [3, 4, 5], 'bounded record retention does not imply byte truncation')
    const value = parseRawFrames(JSON.parse(JSON.stringify(engine.getDeviceFrames(target.id, 2))), targetScope, 2)
    assert.deepEqual(value.frames.map(frame => frame.id), [4, 5])
    for (const english of [false, true]) {
      const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: { phase: 'ready', value }, paused: false, english }))
      assert(html.includes(english ? 'Display limit reached' : '达到显示上限')); assert(html.includes(english ? 'not a full communication history' : '不是完整通信历史'))
      assert(html.includes(english ? 'not proof of a complete frame' : '不证明完整帧'))
    }
  } finally { engine.drivers.set(key, previousDriver) }
}
assert.equal(effects, 0)
console.log(`RAW CAPTURE LENGTH OK: ${longRows} complete 256/65536/262144-byte TX/RX row texts through producer/poller/JSON/parser; ${damagedReads} shortened/odd/ellipsis response rejections with retained/recovered state; TCP/RTU record eviction/limit hints; no clipboard/browser/hardware claim`)
let semanticInputs = 0
for (const transport of ['tcp', 'rtu'] as const) {
  const target = transport === 'tcp' ? device : serial, targetScope = communicationScope(target)
  const prefix = transport === 'tcp' ? [0, 1, 0, 0, 0, 3, 1, 0x83] : [1, 0x83]
  const diag = new ModbusDiagnostics(transport, 2000, transport === 'tcp' ? { deviceId: 1, channelKey: 'tcp:1' } : { channelKey: 'rtu:COM_MOCK' })
  diag.recordFrame('rx', new Uint8Array()); assert.equal(diag.getFrames().length, 0, 'zero bytes do not invent a capture')
  for (let length = 1; length <= prefix.length; length++) diag.recordFrame('rx', Uint8Array.from(prefix.slice(0, length)))
  const codes = [0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 127, 255]
  for (const code of codes) diag.recordFrame('rx', Uint8Array.from([...prefix, code]))
  diag.recordFrame('tx', Uint8Array.from([...prefix, 2]))
  const captured = JSON.parse(JSON.stringify(diag.getFrames())), originalCaptured = JSON.stringify(captured), originalMetrics = JSON.stringify(diag.snapshot())
  const snapshot = parseRawFrames(captured, targetScope, 200), current = new RawFramesRead(target, 200)
  exceptionReader = current
  const marked = focus(current, snapshot.frames).visibleFrames
  assert.deepEqual(marked.map((frame: any) => frame.id), captured.filter((frame: any) => frame.isException === true).map((frame: any) => frame.id))
  assert.equal(marked.length, codes.length + 2, 'the flag is retained even without an exception byte or on TX; no RX-only inference')
  assert.deepEqual(snapshot.frames.slice(0, prefix.length).map(frame => [frame.isException, frame.exceptionCode]), Array.from({ length: prefix.length }, (_, index) => [index === prefix.length - 1, undefined]))
  assert.deepEqual(marked.slice(1, -1).map((frame: any) => frame.exceptionCode), codes, 'unknown or zero byte codes remain raw numbers, not inferred fault names')
  const truncated = marked[0], truncatedHtml = renderToStaticMarkup(renderRow(truncated))
  assert(truncatedHtml.includes('(err ?)') && !truncatedHtml.includes('undefined'), 'marked truncated captures must display an unknown exception code, not a JavaScript undefined value')
  assert.equal(truncated.exceptionCode, undefined, 'a display placeholder cannot fill in the raw code')
  assert(renderToStaticMarkup(renderRow(marked[1])).includes('(err 0)'), 'a real zero byte is retained, not replaced by an unknown placeholder')
  assert(renderToStaticMarkup(renderRow(marked.at(-2))).includes('(err 255)'))
  const mismatch = parseRawFrames([{ ...captured.at(-1), isException: false }], targetScope, 200)
  assert.equal(focus(current, mismatch.frames).visibleFrames.length, 0, 'exception-looking bytes and a code cannot override an explicit false marker')
  const withoutCode = parseRawFrames([{ ...captured.at(-1), functionCode: undefined, exceptionCode: undefined }], targetScope, 200)
  assert.equal(focus(current, withoutCode.frames).visibleFrames.length, 1, 'missing interpreted fields do not remove an existing true marker')
  for (const code of [-1, 256, 1.2, '2', null, NaN, Infinity]) assert.throws(() => parseRawFrames([{ ...captured.at(-1), exceptionCode: code }], targetScope, 200))
  await current.refresh(async () => captured); const accepted = current.snapshot().value!
  await current.refresh(async () => [...captured, { ...captured[0], id: 999, hex: 'GG' }])
  assert.equal(current.snapshot().error, 'invalid'); assert.equal(current.snapshot().value, accepted, 'reject the complete malformed snapshot; never show its valid prefix as current')
  assert.deepEqual(focus(current, accepted.frames).visibleFrames.map((frame: any) => frame.id), marked.map((frame: any) => frame.id))
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: current.snapshot(), paused: false, english, exceptionFocus: focus(current, accepted.frames).control }))
    assert(html.includes(english ? 'could not be verified' : '无法核实')); assert(html.includes(english ? 'Previous captures' : '保留上次显示')); assert(!html.includes(english ? 'This read returned no captures' : '本次读取没有返回捕获记录'))
  }
  const retainedControl = focus(current, accepted.frames).control
  retainedControl.change(false); assert.equal(focus(current, accepted.frames).visibleFrames, accepted.frames)
  retainedControl.change(true)
  const switched = new RawFramesRead(transport === 'tcp' ? serial : device, 200)
  assert.equal(focus(switched, []).control.active, false); retainedControl.change(true); assert.equal(focus(switched, []).control.active, false)
  await switched.refresh(async () => captured)
  assert.equal(switched.snapshot().error, 'invalid'); assert.equal(switched.snapshot().value, undefined, 'new source cannot accept old-source captures or inherit its retained snapshot')
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: switched.snapshot(), paused: false, english }))
    assert(html.includes(english ? 'could not be verified' : '无法核实')); assert(!html.includes(english ? 'This read returned no captures' : '本次读取没有返回捕获记录'))
  }
  await current.refresh(async () => []); assert.equal(current.snapshot().phase, 'ready'); assert.equal(focus(current, current.snapshot().value!.frames).visibleFrames.length, 0)
  assert.equal(JSON.stringify(captured), originalCaptured); assert.equal(JSON.stringify(diag.snapshot()), originalMetrics)
  semanticInputs += prefix.length + codes.length + 2
}
assert.equal(effects, 0)
const shared = parseRawFrames(engine.getDeviceFrames(3, 200), communicationScope(sharedSerial), 200)
assert.deepEqual(shared.frames, serialParsed.frames, 'same channel/slave filter can return the same captures for different configured devices')
assert(shared.frames.every(frame => frame.sourceMetadataMatched), 'matching RTU metadata proves channel matching, not exclusive device ownership')
console.log('RAW SHARED FILTER BOUNDARY: identical same-channel/slave captures match two configured device IDs; exclusive ownership is not established')
const times = ['2026-11-08T13:00:00.001Z', '2026-11-09T13:00:00.001Z', '2026-11-09T13:00:00.999Z', '2026-11-09T13:00:00.123+08:00', '2026-11-09T13:00:00.123']
for (const [index, timestamp] of times.entries()) {
  const snapshot = parseRawFrames([{ ...raw[0], id: index + 100, timestamp, direction: index % 2 ? 'rx' : 'tx' }], scope, 200), original = JSON.stringify(snapshot)
  const row = renderRow(snapshot.frames[0]), shown = row.props.children[0].props
  assert.equal(shown.children, timestamp, 'capture rows must preserve the original date, precision and explicit or absent zone instead of showing seconds alone')
  assert.equal(shown.title, timestamp); assert.equal(row.props.children[1].props.children, index % 2 ? 'RX' : 'TX'); assert.equal(JSON.stringify(snapshot), original)
}
const previousZone = process.env.TZ, offsets = new Set<number>()
const zonedTimes = [
  '2026-01-01T00:00:00.123+14:00', '2025-12-31T10:00:00.123Z',
  '2025-12-31T22:00:00.123-12:00', '2026-01-01T10:00:00.123+00:00',
  '2026-11-01T01:30:00.100-04:00', '2026-11-01T01:30:00.100-05:00',
  '2026-03-08T01:59:59.999-05:00', '2026-03-08T03:00:00.000-04:00',
  '2026-10-25T02:30:00.123+02:00', '2026-10-25T02:30:00.123+01:00',
  '2026-03-29T01:59:59.999+01:00', '2026-03-29T03:00:00.000+02:00',
  '2026-03-08T01:59-05:00', '2026-03-08T01:59:59-05:00',
  '2026-03-08T01:59:59.1-05:00', '2026-03-08T01:59:59.123456789-05:00',
  '2026-03-08T02:30:00.123', '2026-11-01T01:30:00.123',
]
const invalidTimes = [null, undefined, 0, NaN, {}, '', 'PRIVATE invalid timestamp', '2026-13-01T00:00:00Z', '2026-01-32T00:00:00Z', '2026-01-01T25:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00']
let zoneRows = 0, rejectedTimes = 0, toleratedCalendar = 0
try {
  for (const zone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai']) {
    process.env.TZ = zone; offsets.add(new Date('2026-07-01T00:00:00Z').getTimezoneOffset())
    if (zone === 'America/New_York') {
      assert.deepEqual([4, 5, 6, 7].map(index => new Date(zonedTimes[index]).getTimezoneOffset()), [240, 300, 300, 240], 'runtime timezone data must confirm the selected US DST boundaries')
      assert.equal(new Date(zonedTimes[16]).getHours(), 3, 'the native parser may normalize a local spring gap; raw capture text must not follow that normalization')
    }
    if (zone === 'Europe/Berlin') assert.deepEqual([8, 9, 10, 11].map(index => new Date(zonedTimes[index]).getTimezoneOffset()), [-120, -60, -60, -120], 'runtime timezone data must confirm the selected European DST boundaries')
    assert.equal(Date.parse(zonedTimes[0]), Date.parse(zonedTimes[1])); assert.equal(Date.parse(zonedTimes[2]), Date.parse(zonedTimes[3]))
    for (const [a, b, difference] of [[4, 5, 3600000], [6, 7, 1], [8, 9, 3600000], [10, 11, 1]]) assert.equal(Date.parse(zonedTimes[b]) - Date.parse(zonedTimes[a]), difference)
    const labels: string[] = []
    for (const timestamp of zonedTimes) {
      const source = { ...raw[0], timestamp }, snapshot = parseRawFrames([source], scope, 200), row = renderRow(snapshot.frames[0]), label = row.props.children[0].props
      assert.equal(label.children, timestamp, 'ambient local zone cannot add seconds/fraction/offset or collapse a repeated wall time')
      assert.equal(label.title, timestamp); assert.equal(source.timestamp, timestamp); labels.push(label.children); zoneRows++
    }
    assert.notEqual(labels[4], labels[5]); assert.notEqual(labels[8], labels[9], 'explicit offsets keep repeated wall-clock records distinguishable')
    const read = new RawFramesRead(device, 200)
    await read.refresh(async () => [{ ...raw[0], timestamp: '2026-01-01T25:00:00Z' }]); assert.equal(read.snapshot().phase, 'error'); assert.equal(read.snapshot().value, undefined)
    for (const english of [false, true]) { const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: read.snapshot(), paused: false, english })); assert(!html.includes(english ? 'This read returned no captures' : '本次读取没有返回捕获记录')); assert(!html.includes('1970-01-01')) }
    rejectedTimes++; await read.refresh(async () => raw); const accepted = read.snapshot().value!
    for (const timestamp of invalidTimes) {
      const damaged = { ...raw[1], timestamp }
      await read.refresh(async () => [raw[0], damaged]); assert.equal(read.snapshot().phase, 'error'); assert.equal(read.snapshot().error, 'invalid')
      assert.equal(read.snapshot().value, accepted, 'invalid time rejects the entire new response instead of showing a valid prefix as fresh')
      assert.equal(damaged.timestamp, timestamp); assert.equal(renderRow(accepted.frames[0]).props.children[0].props.children, accepted.frames[0].timestamp)
      for (const english of [false, true]) {
        const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: read.snapshot(), paused: false, english }))
        assert(html.includes(english ? 'Previous captures' : '保留上次显示')); assert(!html.includes('PRIVATE')); assert(!html.includes(english ? 'This read returned no captures' : '本次读取没有返回捕获记录'))
      }
      rejectedTimes++
    }
    // Finite Date.parse is a legacy compatibility check, not strict calendar/IANA-zone validation.
    const legacyCalendar = '2026-02-30T12:00:00.123Z'
    if (Number.isFinite(Date.parse(legacyCalendar))) {
      const literal = parseRawFrames([{ ...raw[0], timestamp: legacyCalendar }], scope, 200)
      assert.equal(renderRow(literal.frames[0]).props.children[0].props.children, legacyCalendar, 'never silently replace a tolerated raw calendar string with its normalized date')
      assert.notEqual(legacyCalendar, new Date(Date.parse(legacyCalendar)).toISOString()); toleratedCalendar++
    } else assert.throws(() => parseRawFrames([{ ...raw[0], timestamp: legacyCalendar }], scope, 200))
    await read.refresh(async () => raw); assert.equal(read.snapshot().phase, 'ready'); read.cancel()
    for (const english of [false, true]) {
      const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: read.snapshot(), paused: false, english }))
      assert(html.includes(english ? 'missing zone stays unknown' : '未标时区则不推断'))
    }
  }
  assert.equal(offsets.size, 4, 'the matrix must actually exercise different process-local zones')
} finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone }
assert.equal(process.env.TZ, previousZone); assert.equal(effects, 0)
console.log(`RAW CAPTURE TIMEZONE OK: ${zoneRows} raw labels across 4 ambient zones, fixed-offset date boundaries/DST repeats and gaps, original precision; ${rejectedTimes} invalid whole-response rejections/recovery; ${toleratedCalendar} Date.parse calendar compatibility observations without normalization; TZ restored, no hardware`)
const sharedAttribute = status.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(appSource) === 'sharedSerial') as ts.JsxAttribute
assert(sharedAttribute?.initializer && ts.isJsxExpression(sharedAttribute.initializer), 'actual RTU display must provide channel scope even when its capture list is empty')
const sharedExpression = (sharedAttribute.initializer as ts.JsxExpression).expression!
assert.equal(evaluate(sharedExpression, { device: serial }), true); assert.equal(evaluate(sharedExpression, { device }), false)
for (const english of [false, true]) {
  for (const value of [shared, parseRawFrames([], communicationScope(serial), 200)]) {
    const html = renderToStaticMarkup(createElement(RawFramesStatus, { state: { phase: 'ready', value }, paused: false, english, sharedSerial: true }))
    assert(html.includes(english ? 'Shared RTU channel' : '共享RTU通道')); assert(html.includes(english ? 'not exclusive' : '不能认定属于当前设备')); assert(html.includes(english ? 'backend sent' : '后台发送')); assert(html.includes(english ? 'not a verified response' : '不保证有效响应'))
  }
  const tcp = renderToStaticMarkup(createElement(RawFramesStatus, { state: { phase: 'ready', value: parsed }, paused: false, english, sharedSerial: false }))
  assert(!tcp.includes(english ? 'Shared RTU channel' : '共享RTU通道'))
}
assert.equal(effects, 0)
console.log('RAW CAPTURE DETAILS OK: original timestamps across days/milliseconds/offsets/unknown zone, actual TX/RX rows, shared same-slave RTU non-exclusive attribution and empty-channel hints; original records and getters unchanged')
console.log(`RAW FRAMES SEMANTICS OK: ${semanticInputs} TCP/RTU capture inputs, actual row rendering, flag-only selection, zero/unknown/missing codes, invalid whole-snapshot retention/recovery and source/control isolation; no capture mutation or hardware`)
await import('./test-raw-frames-composition.ts')
console.log('RAW FRAMES FOCUS OK: actual view selection/map and checkbox/show-all callbacks, bilingual counts and distinct empty/no-match, legacy/error/pause, source/limit/late-control isolation; local snapshot only')
console.log('RAW FRAMES READ OK: producer/poller memory getters and RTU filtering, slow-response acceptance, single-flight, timeout/recovery, pause/late success/error/finalizer isolation, source/limit ownership, legacy metadata, strict immutable captures and bilingual status SSR; no real data, files, network, hardware, model or DOM automation')
