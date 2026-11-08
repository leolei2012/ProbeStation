import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { Context } from 'cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import inject from 'light-my-request'
import * as configPlugin from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { closeResourceDependents } from '../packages/core/src/resource-close.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const within = async <T,>(work: PromiseLike<T>, label = 'operation') => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('synthetic disconnect timeout: ' + label)), 4000) })]) } finally { clearTimeout(timer) } }
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target))
const outcome = <T,>(work: PromiseLike<T>) => Promise.resolve(work).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic disconnect', version: '1' } } }
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  constructor(readonly handler: http.RequestListener) { super() }
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); return this }
  close(done: () => void) { this.closes++; this.listening = false; queueMicrotask(done); return this }
}
const denied: string[] = [], unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name) }
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', onUnhandled)
const modes = process.argv[2] ? [process.argv[2]] : ['abort-init', 'memory-disconnect', 'memory-disconnect-failure', 'http-abort', 'concurrent-close', 'concurrent-close-failure', 'delete-overlap']
try {
  for (const mode of modes) {
    const ctx = new Context(), release = gate(), entered = gate(), closeEntered = gate(), closeRelease = gate(), failure = Error('synthetic disconnect/close failure')
    const transports = new Set<StreamableHTTPServerTransport>(), closed = new Map<StreamableHTTPServerTransport, number>()
    const create = http.createServer, start = StreamableHTTPServerTransport.prototype.start, close = StreamableHTTPServerTransport.prototype.close, handle = StreamableHTTPServerTransport.prototype.handleRequest
    let cfg!: configPlugin.ConfigStore, listener!: FakeHttp, sdk: McpServer | undefined, client: Client | undefined, handled = 0, explicitCloses = 0, exports = 0
    try {
      await ctx.plugin(configPlugin, { dbPath: ':memory:' }); cfg = ctx.get('config', false) as configPlugin.ConfigStore
      const store = { flush: async () => {} }, poller = {}, ota = {}, sink = { exportCsv: async () => { exports++; entered.resolve(); await release.promise; assert.equal(cfg.listObjects().length, 1, 'configuration must outlive accepted work after disconnect'); if (mode === 'memory-disconnect-failure') throw failure; return 'synthetic csv' } }
      await ctx.plugin({ name: 'inert-mcp-disconnect-services', apply(context: Context) { context.provide('store', store as any); context.provide('poller', poller as any); context.provide('ota', ota as any); context.provide('sink', sink as any) } })
      http.createServer = ((handler: http.RequestListener) => listener = new FakeHttp(handler)) as unknown as typeof create
      try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
      await tick()
      StreamableHTTPServerTransport.prototype.start = async function () { transports.add(this); const onclose = this.onclose; this.onclose = () => { closed.set(this, (closed.get(this) ?? 0) + 1); onclose?.() }; if (mode === 'abort-init') { entered.resolve(); await release.promise }; return start.call(this) }
      StreamableHTTPServerTransport.prototype.close = async function () { explicitCloses++; if (mode.startsWith('concurrent-close') || mode === 'delete-overlap') { closeEntered.resolve(); await closeRelease.promise }; await close.call(this); if (mode === 'concurrent-close-failure' && explicitCloses === 1) throw failure }
      StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) { handled++; return handle.apply(this, args) }
      const initialize = () => within(inject(listener.handler, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: init }))
      const headersFor = (session: string) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' })
      if (mode === 'abort-init') {
        let reply: http.ServerResponse | undefined
        const request = outcome(inject((req, res) => { reply = res; listener.handler(req, res) }, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: init }))
        await within(entered.promise, 'abort-init connection entered'); assert(reply); reply.destroy(failure); assert((await within(request, 'abort-init destroyed reply')).error instanceof Error); assert.equal(reply.destroyed, true)
        release.resolve(); await tick(); await tick(); await tick()
        assert.equal(handled, 0, 'an already disconnected initializer must not reach SDK request handling')
        assert.equal(explicitCloses, 1, 'abandoned pre-session transport must close before global shutdown')
      } else if (mode.startsWith('memory-disconnect') || mode === 'http-abort') {
        const device = cfg.createObject('synthetic disconnect', 'mock.invalid', 502), args = { device_id: device.id, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', format: 'csv' }
        let request: ReturnType<typeof outcome>, session = '', reply: http.ServerResponse | undefined
        if (mode === 'http-abort') {
          const initialized = await initialize(); assert.equal(initialized.statusCode, 200); session = String(initialized.headers['mcp-session-id'])
          request = outcome(inject((req, res) => { reply = res; listener.handler(req, res) }, { method: 'POST', url: '/mcp', headers: headersFor(session), payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'export_history', arguments: args } } }))
        } else {
          sdk = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer(); client = new Client({ name: 'synthetic disconnect', version: '1' })
          const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([sdk.connect(b), client.connect(a)])
          request = outcome(client.callTool({ name: 'export_history', arguments: args }))
        }
        await within(entered.promise); if (mode === 'http-abort') { assert(reply); reply.destroy(failure) } else await client!.close()
        assert((await within(request)).error instanceof Error, 'client observes disconnect, not a successful tool result')
        if (mode === 'http-abort') {
          assert.equal(closed.size, 0, 'aborting one HTTP stream must preserve its initialized logical session')
          const reused = await within(inject(listener.handler, { method: 'POST', url: '/mcp', headers: headersFor(session), payload: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } })); assert.equal(reused.statusCode, 200)
        }
        let finished = 0; const shutdowns = [cfg, store, poller, ota].map(owner => closeResourceDependents(owner).then(errors => { finished++; return errors }))
        await tick(); await tick(); assert.equal(finished, 0, 'all concurrent owner shutdowns must await disconnected accepted work'); assert.equal(exports, 1)
        release.resolve(); const results = await within(Promise.all(shutdowns))
        for (const errors of results) { if (mode === 'memory-disconnect-failure') assert(errors.some(error => contains(error, failure))); else assert.deepEqual(errors, []) }
        assert.equal(exports, 1, 'disconnect/close must not replay export work')
      } else {
        const first = await initialize(), second = await initialize(); assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200); assert.notEqual(first.headers['mcp-session-id'], second.headers['mcp-session-id'])
        const shutdowns = [cfg, store, poller, ota].map(owner => closeResourceDependents(owner))
        await within(closeEntered.promise)
        const deletion = mode === 'delete-overlap' ? outcome(inject(listener.handler, { method: 'DELETE', url: '/mcp', headers: headersFor(String(first.headers['mcp-session-id'])) })) : undefined
        closeRelease.resolve(); const results = await within(Promise.all(shutdowns))
        if (deletion) assert.equal((await within(deletion)).value?.statusCode, 503, 'new DELETE after shutdown starts uses the existing closing response')
        for (const errors of results) { if (mode === 'concurrent-close-failure') assert(errors.some(error => contains(error, failure))); else assert.deepEqual(errors, []) }
        assert.equal(explicitCloses, 2, 'four owners must not multiply cleanup of two sessions')
      }
      await within(closeResourceDependents(cfg)); assert.equal(listener.closes, 1); assert.equal(closed.size, transports.size); assert([...closed.values()].every(count => count === 1), 'each SDK transport emits onclose once')
      const previous = explicitCloses; await closeResourceDependents(cfg); assert.equal(explicitCloses, previous)
      console.log('MCP DISCONNECT OK: ' + mode)
    } finally {
      release.resolve(); closeRelease.resolve(); http.createServer = create
      StreamableHTTPServerTransport.prototype.start = start; StreamableHTTPServerTransport.prototype.close = close; StreamableHTTPServerTransport.prototype.handleRequest = handle
      await client?.close(); await sdk?.close(); for (const transport of transports) await close.call(transport).catch(() => {})
      await ctx.fiber.dispose(); await cfg?.close().catch(() => {})
    }
  }
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', onUnhandled) }
console.log('MCP DISCONNECT TEST OK: concurrent owner shutdown, deferred accepted work, SDK memory clients and simulated HTTP aborts; no sockets, real devices/data or model')
