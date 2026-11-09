import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Fastify from 'fastify'
import { apply } from '../packages/poller/src/index.ts'
import { ModbusDiagnostics } from '../packages/modbus/src/diagnostics.ts'
import { registerDiagnosticsCleanup } from '../packages/api/src/diagnostics-cleanup.ts'
import { communicationScope, CommunicationSummaryRead } from '../apps/web/src/communication-summary.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommunicationSummaryView } from '../apps/web/src/CommunicationSummaryView.tsx'

const source = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let handler: ts.Node | undefined
const find = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/monitor_objects/:id/diagnostics') handler = node.arguments[1]; ts.forEachChild(node, find) }; find(source); assert(handler)
const route = (poller: any) => Function('poller', ts.transpile('return (' + handler!.getText(source) + ')', { target: ts.ScriptTarget.ES2022 }))(poller)
let passed = 0
for (const [transport, patch] of [['tcp', { ip: 'changed.mock.invalid' }], ['tcp', { port: 1502 }], ['rtu', { baudRate: 19200 }], ['rtu', { parity: 'even' }], ['rtu', { stopBits: 2 }], ['rtu', { dataBits: 7 }], ['rtu', { flowControl: 'rtscts' }]] as const) {
  let object: any = { id: 1, name: 'mock', isActive: 1, mode: 'master', transport, ip: 'before.mock.invalid', port: 502, serialPath: 'MOCK_STATS', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none' }, engine: any, scope = Symbol('configuration'), connects = 0, disconnects = 0, reads = 0, connectedReads = 0, forbidden = 0
  let insideStats: (() => void) | undefined, insideConnected: (() => void) | undefined
  const statuses: any[] = []
  apply({ config: { getObject: (id: number) => object?.id === id ? { ...object } : null, listObjects: () => object ? [{ ...object }] : [], getRecordingIntervalScope: () => scope }, store: { write() { forbidden++ } }, modbus: { createDriver: (kind: 'tcp' | 'rtu', identity: any) => {
    const diag = new ModbusDiagnostics(kind, 2000, identity); let connected = false
    return { isConnected() { connectedReads++; const result = connected; insideConnected?.(); return result }, async connect() { connected = true; connects++; for (let n = 0; n < connects; n++) { diag.recordFrame('rx', Uint8Array.from(kind === 'tcp' ? [0, 1, 0, 0, 0, 3, 1, 0x83, 2] : [1, 0x83, 2])); diag.recordSuccess(1) } }, async disconnect() { disconnects++; connected = false }, getDiagnostics() { reads++; const value = diag.snapshot(); insideStats?.(); return value }, clearDiagnostics() { forbidden++ }, readHoldingRegisters() { forbidden++ }, writeRegister() { forbidden++ } }
  } }, on() {}, provide(_name: string, value: any) { engine = value }, emit(name: string, value: any) { if (name === 'device/status') statuses.push(value); else forbidden++ } } as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
  const app = Fastify(); app.get('/api/monitor_objects/:id/diagnostics', route(engine)); registerDiagnosticsCleanup(app, engine)
  const get = async (url: string) => { const reply = await app.inject(url); if (reply.statusCode !== 200) { assert(!reply.body.includes('.mock.invalid')); throw Error('mock GET failed') }; return reply.json() }
  const preview = () => app.inject('/api/monitor_objects/1/diagnostics/cleanup-preview')
  try {
    const driver = await engine.getDriver(object), key = engine.driverKey(object), original = { ...object }, reader = new CommunicationSummaryRead(communicationScope(object))
    await reader.refresh(get); const accepted = reader.snapshot().value!; assert.equal(accepted.connected, true); assert.equal(accepted.metrics!.successCount, 1)
    assert.equal((await preview()).statusCode, 200)
    object = { ...object, name: 'ordinary metadata', pollIntervalMs: 77 }; assert.equal(engine.getDeviceDiagnostics(1).connected, true)
    object = { ...object, ...patch }; const before = [reads, connectedReads], fresh = new CommunicationSummaryRead(communicationScope(object))
    const probe = { statistics: (await app.inject('/api/monitor_objects/1/diagnostics')).statusCode, connected: engine.isDeviceConnected(1), preview: (await preview()).statusCode }
    if (probe.statistics === 200 || probe.connected || probe.preview === 200) console.log('STALE DIAGNOSTIC PROBE: ' + JSON.stringify(probe))
    await fresh.refresh(get); assert.equal(fresh.snapshot().phase, 'error', 'statistics must not attribute an old driver to a newly configured source'); assert.equal(fresh.snapshot().value, undefined)
    await reader.refresh(get); assert.equal(reader.snapshot().phase, 'error'); assert.equal(reader.snapshot().value, accepted)
    for (const english of [false, true]) { const html = renderToStaticMarkup(createElement(CommunicationSummaryView, { state: reader.snapshot(), english, refresh() {} })); assert(html.includes(english ? 'previous result' : '上次结果')) }
    assert.equal(engine.isDeviceConnected(1), false, 'an old connected driver does not establish a current-source connection'); assert.equal(engine.listConnectionStates()[0].connected, false)
    engine.deviceConnected.set(1, true); engine.updateDeviceStatus({ ...object }); assert.equal(statuses.at(-1)?.connected, false, 'pushed connection state must not preserve old-source connected=true')
    assert.equal((await preview()).statusCode, 503, 'read-only preview must not offer old counters under a new target'); assert.deepEqual([reads, connectedReads], before, 'refusal reads neither old counters nor old connection state')
    assert.equal(connects, 1); assert.equal(disconnects, 0)
    object = { ...original }; engine.driverBindings.delete(driver); assert.throws(() => engine.getDeviceDiagnostics(1), /已变化/); assert.equal(engine.isDeviceConnected(1), false); assert.equal((await preview()).statusCode, 503); engine.driverBindings.set(driver, engine.connectionSignature(object))
    for (const action of ['source', 'delete', 'driver']) {
      const restore = () => { object = { ...original }; engine.drivers.set(key, driver) }
      const mutate = () => { if (action === 'source') object = { ...object, ...patch }; if (action === 'delete') object = null; if (action === 'driver') engine.drivers.set(key, {}) }
      restore(); insideStats = mutate; assert.throws(() => engine.getDeviceDiagnostics(1), /已变化/); insideStats = undefined
      restore(); insideConnected = mutate; assert.equal(engine.isDeviceConnected(1), false); insideConnected = undefined
      restore(); insideStats = mutate; assert.equal((await preview()).statusCode, 503, 'preview must recheck after reading counters'); insideStats = undefined
    }
    object = { ...original }; engine.drivers.set(key, driver); insideStats = () => { scope = Symbol('reopened configuration') }; assert.equal((await preview()).statusCode, 503); insideStats = undefined
    object = { ...original, ...patch }; engine.drivers.set(key, driver); const next = await engine.getDriver(object); assert.notEqual(next, driver)
    await fresh.refresh(get); assert.equal(fresh.snapshot().phase, 'ready'); assert.equal(fresh.snapshot().value!.metrics!.successCount, 2); assert.equal(engine.isDeviceConnected(1), true); assert.equal((await preview()).statusCode, 200)
    engine.drivers.delete(key); assert.equal(engine.getDeviceDiagnostics(1).metrics, null); assert.equal(engine.getDeviceDiagnostics(1).connected, false); assert.equal((await preview()).statusCode, 503); engine.drivers.set(key, next)
    assert.equal(connects, 2); assert.equal(disconnects, 1); assert.equal(forbidden, 0)
    passed++; console.log('COMMUNICATION BINDING OK: ' + transport + '/' + Object.keys(patch)[0])
  } finally { insideStats = insideConnected = undefined; await app.close(); await engine.stopAll() }
}
console.log(`COMMUNICATION BINDING TEST OK: ${passed} actual-route/mock-driver TCP/RTU reconfigurations, stale counter/connection/preview refusal, unknown binding and reentrant read checks, metadata compatibility, explicit mock recovery and zero getter I/O; expected frontend version, ABA and physical source remain unproven`)
