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
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const within = async <T,>(work: PromiseLike<T>) => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('synthetic lifecycle timeout')), 4000) })]) } finally { clearTimeout(timer) } }
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target))
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic lifecycle', version: '1' } } }
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  constructor(readonly handler: http.RequestListener, readonly mode: string, readonly failure: Error) { super() }
  listen() { if (this.mode === 'bind-throw') throw this.failure; queueMicrotask(() => { if (this.mode === 'bind-error') this.emit('error', this.failure); else { this.listening = true; this.emit('listening') } }); return this }
  close(done: (error?: Error) => void) { this.closes++; this.listening = false; queueMicrotask(() => done()); return this }
}
const denied: string[] = [], unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
const originalListen = net.Server.prototype.listen, originalConnect = net.Socket.prototype.connect, originalFetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name) }
net.Server.prototype.listen = block('listen') as typeof originalListen; net.Socket.prototype.connect = block('connect') as typeof originalConnect; globalThis.fetch = block('fetch') as typeof originalFetch
process.on('unhandledRejection', onUnhandled)
const chosen = process.argv[2], modes = chosen ? [chosen] : ['registration', 'connect-reject', 'uninitialized', 'pending-init', 'request-reject', 'normal', 'bind-throw', 'bind-error', 'close-failure', 'tools']
try {
  for (const mode of modes) {
    const ctx = new Context(), failure = Error('synthetic ' + mode), release = deferred(), entered = deferred()
    let listener!: FakeHttp, cfg!: configPlugin.ConfigStore, sdk: McpServer | undefined, client: Client | undefined, closes = 0, handled = 0
    const create = http.createServer, register = McpServer.prototype.registerTool, start = StreamableHTTPServerTransport.prototype.start, close = StreamableHTTPServerTransport.prototype.close, handle = StreamableHTTPServerTransport.prototype.handleRequest
    const transportInstances = new Set<StreamableHTTPServerTransport>()
    const closedTransports = new Set<StreamableHTTPServerTransport>()
    try {
      await ctx.plugin(configPlugin, { dbPath: ':memory:' }); cfg = ctx.get('config', false) as configPlugin.ConfigStore
      await ctx.plugin({ name: 'inert-mcp-lifecycle-services', apply(context: Context) { for (const service of ['store', 'poller', 'ota', 'sink']) context.provide(service as any, {} as any) } })
      http.createServer = ((handler: http.RequestListener) => listener = new FakeHttp(handler, mode, failure)) as unknown as typeof create
      try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
      await tick()
      const mcp = ctx.get('mcp', false) as { createServer(): McpServer }
      StreamableHTTPServerTransport.prototype.start = async function () { transportInstances.add(this); const onclose = this.onclose; this.onclose = () => { closedTransports.add(this); onclose?.() }; if (mode === 'connect-reject') throw failure; if (mode === 'pending-init') { entered.resolve(); await release.promise }; return start.call(this) }
      StreamableHTTPServerTransport.prototype.close = async function () { closes++; await close.call(this); if (mode === 'close-failure') throw failure }
      if (mode === 'registration') McpServer.prototype.registerTool = function () { throw failure } as typeof register
      if (mode === 'connect-reject' || mode === 'pending-init' || mode === 'request-reject') StreamableHTTPServerTransport.prototype.handleRequest = async function (_req, res) { handled++; if (mode === 'request-reject') throw failure; res.statusCode = 200; res.end() }
      if (mode === 'registration' || mode === 'connect-reject' || mode === 'pending-init' || mode === 'request-reject') {
        const request = Object.assign(new EventEmitter(), { method: 'POST', headers: {} }), reply = { statusCode: 200, headersSent: false, ended: false, end() { this.ended = true } }
        listener.handler(request as unknown as http.IncomingMessage, reply as unknown as http.ServerResponse)
        request.emit('data', Buffer.from(JSON.stringify(init)))
        assert.doesNotThrow(() => request.emit('end'), 'registration failure must not escape the request callback')
        if (mode === 'pending-init') {
          await within(entered.promise)
          let finished = false; const shutdown = closeResourceDependents(cfg).then(errors => { finished = true; return errors })
          await tick(); await tick(); assert.equal(finished, false); assert.equal(closes, 1)
          release.resolve(); assert.deepEqual(await within(shutdown), [])
        }
        await tick(); await tick(); await tick()
        assert.equal(handled, mode === 'request-reject' ? 1 : 0, 'failed/closing SDK connection must not process initialization')
        assert.equal(reply.statusCode, mode === 'pending-init' ? 503 : 500); assert.equal(reply.ended, true)
        if (mode !== 'registration') assert.equal(closes, 1, 'failed pre-session transport must close immediately')
      } else if (mode === 'tools') {
        sdk = mcp.createServer(); client = new Client({ name: 'synthetic lifecycle', version: '1' })
        const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([sdk.connect(b), client.connect(a)])
        const originalList = cfg.listObjects.bind(cfg)
        cfg.listObjects = () => { throw failure }
        assert.equal((await within(client.callTool({ name: 'list_devices', arguments: {} }))).isError, true)
        cfg.listObjects = originalList
        const device = cfg.createObject('synthetic lifecycle', 'mock.invalid', 502), sink = ctx.get('sink', false) as any
        ;(ctx.get('store', false) as any).flush = async () => {}
        const exportArgs = { device_id: device.id, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', format: 'csv' }
        sink.exportCsv = async () => { throw failure }
        assert.equal((await within(client.callTool({ name: 'export_history', arguments: exportArgs }))).isError, true)
        assert.equal((await within(client.callTool({ name: 'list_devices', arguments: {} }))).isError, undefined)
        sink.exportCsv = async () => { entered.resolve(); await release.promise; assert.equal(cfg.listObjects()[0].id, device.id); return 'synthetic csv' }
        const work = client.callTool({ name: 'export_history', arguments: exportArgs }); await within(entered.promise)
        let finished = false; const shutdown = closeResourceDependents(cfg).then(errors => { finished = true; return errors })
        await tick(); await tick(); assert.equal(finished, false, 'shutdown must drain an accepted tool before releasing configuration')
        assert.equal((await within(client.callTool({ name: 'list_devices', arguments: {} }))).isError, true)
        release.resolve(); assert.equal((await within(work)).isError, undefined); assert.deepEqual(await within(shutdown), [])
      } else if (mode !== 'bind-throw' && mode !== 'bind-error') {
        const response = await within(inject(listener.handler, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: mode === 'uninitialized' ? 'application/json' : 'application/json, text/event-stream' }, payload: init }))
        assert.equal(response.statusCode, mode === 'uninitialized' ? 406 : 200)
        assert.equal(Boolean(response.headers['mcp-session-id']), mode !== 'uninitialized')
        if (mode === 'normal') {
          const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': String(response.headers['mcp-session-id']), 'mcp-protocol-version': '2025-03-26' }
          const tools = await within(inject(listener.handler, { method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } })); assert.equal(tools.statusCode, 200); assert(tools.body.includes('list_devices'))
          assert.equal((await within(inject(listener.handler, { method: 'DELETE', url: '/mcp', headers }))).statusCode, 200)
          assert.equal((await within(inject(listener.handler, { method: 'GET', url: '/mcp', headers }))).statusCode, 400)
          const again = await within(inject(listener.handler, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: init })); assert.equal(again.statusCode, 200); assert.notEqual(again.headers['mcp-session-id'], response.headers['mcp-session-id'])
        }
      }
      McpServer.prototype.registerTool = register
      const errors = await within(closeResourceDependents(cfg))
      if (mode === 'bind-throw' || mode === 'bind-error' || mode === 'close-failure') assert(errors.some(error => contains(error, failure)), 'original initialization/close error must remain observable')
      else assert.deepEqual(errors, [])
      if (mode === 'uninitialized' || mode === 'normal' || mode === 'close-failure') assert.equal(closes, 1, 'the retained transport must receive explicit cleanup')
      assert.equal(closedTransports.size, transportInstances.size, 'all started HTTP transports, including SDK-deleted sessions, must report closure')
      const previousCloses = closes; await closeResourceDependents(cfg); assert.equal(closes, previousCloses, 'cleanup must be idempotent')
      assert.throws(() => mcp.createServer(), /closing or closed/)
      assert.equal(listener.closes, mode.startsWith('bind-') ? 0 : 1)
      const lateRequest = Object.assign(new EventEmitter(), { method: 'POST', headers: {} }), lateReply = { statusCode: 200, headersSent: false, ended: false, end() { this.ended = true } }
      listener.handler(lateRequest as unknown as http.IncomingMessage, lateReply as unknown as http.ServerResponse); assert.equal(lateReply.statusCode, 503); assert.equal(lateReply.ended, true)
      if (client) assert.equal((await within(client.callTool({ name: 'list_devices', arguments: {} }))).isError, true, 'retained public server must reject new tool work after shutdown')
      console.log('MCP LIFECYCLE OK: ' + mode)
    } finally {
      release.resolve(); http.createServer = create; McpServer.prototype.registerTool = register
      StreamableHTTPServerTransport.prototype.start = start; StreamableHTTPServerTransport.prototype.close = close; StreamableHTTPServerTransport.prototype.handleRequest = handle
      await client?.close(); await sdk?.close(); await ctx.fiber.dispose(); await cfg?.close().catch(() => {})
      for (const transport of transportInstances) await close.call(transport).catch(() => {})
    }
  }
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, [])
} finally { net.Server.prototype.listen = originalListen; net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; process.off('unhandledRejection', onUnhandled) }
console.log('MCP LIFECYCLE TEST OK: fake listeners, memory SDK clients/configuration and synthetic failures only; no real HTTP client, device, user data or model')
