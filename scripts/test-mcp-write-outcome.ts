import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { Context } from 'cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const outcome = <T,>(work: PromiseLike<T>) => Promise.resolve(work).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
const within = async <T,>(work: PromiseLike<T>) => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('synthetic write outcome timeout')), 4000) })]) } finally { clearTimeout(timer) } }
const body = (result: any) => JSON.parse(result.content[0].text)
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); return this }
  close(done: () => void) { this.closes++; this.listening = false; queueMicrotask(done); return this }
}
const modes = process.argv[2] ? [process.argv[2]] : ['log-failure', 'warning-failure', 'write-ack-loss', 'write-response-loss', 'group-response-loss', 'device-response-loss', 'guarded-response-loss']
const unhandled: unknown[] = [], denied: string[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch, block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name) }
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', onUnhandled)
try {
  for (const mode of modes) {
    const ctx = new Context(), listener = new FakeHttp(), peers: { sdk: McpServer; client: Client; remote: InMemoryTransport }[] = [], releases: (() => void)[] = []
    const writeCalls: unknown[][] = [], warnings: string[] = [], writeEntered = gate(), finishWrite = gate(), writeDone = gate(); let writeEffects = 0, cfg!: configPlugin.ConfigStore
    const create = http.createServer
    try {
      ctx.logger.exporter({ export(message) { if (message.name === 'mcp' && message.type === 'warn') { warnings.push(message.args.join(' ')); if (mode === 'warning-failure') throw Error('synthetic warning exporter failure') } } })
      await ctx.plugin(configPlugin, { dbPath: ':memory:' }); cfg = ctx.get('config', false) as configPlugin.ConfigStore
      const device = cfg.createObject('synthetic base', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic base', 3, 0, 4), register = cfg.createRegister(group.id, device.id, 'before', 3, 0, 'uint16')
      const poller = { async write(...args: unknown[]) { writeCalls.push(args); if (mode === 'write-response-loss' && writeCalls.length === 1) { writeEntered.resolve(); await finishWrite.promise }; writeEffects++; writeDone.resolve(); if (mode === 'write-ack-loss') throw Error('synthetic mock effect applied but acknowledgement failed') } }
      await ctx.plugin({ name: 'inert-mcp-write-outcome-services', apply(context: Context) { context.provide('poller', poller as any); for (const name of ['store', 'ota', 'sink']) context.provide(name as any, {} as any) } })
      http.createServer = (() => listener) as unknown as typeof create
      try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = create }
      const factory = (ctx.get('mcp', false) as { createServer(): McpServer }).createServer
      const open = async () => { const sdk = factory(), client = new Client({ name: 'synthetic outcome', version: '1' }), [local, remote] = InMemoryTransport.createLinkedPair(); peers.push({ sdk, client, remote }); await Promise.all([sdk.connect(remote), client.connect(local)]); return peers.at(-1)! }
      const first = await open(), writeArgs = { device_id: device.id, address: 0, value: 42, area: 'holding-register' }
      if (['log-failure', 'warning-failure', 'write-ack-loss', 'write-response-loss'].includes(mode)) {
        cfg.log = () => { throw Error('synthetic log failure must not run') }
        const result = await within(first.client.callTool({ name: 'write_register', arguments: writeArgs }))
        assert.equal(result.isError, true); assert.equal(body(result).code, 'DEVICE_WRITE_BLOCKED'); assert.equal(body(result).retryable, false)
        await first.client.close(); const second = await open()
        const retry = await within(second.client.callTool({ name: 'write_register', arguments: writeArgs }))
        assert.equal(body(retry).code, 'DEVICE_WRITE_BLOCKED'); assert.equal(writeCalls.length, 0); assert.equal(writeEffects, 0); assert.equal(warnings.length, 0)
      } else {
        const send = first.remote.send.bind(first.remote), responseReady = gate(), release = gate(), sendDone = gate(); releases.push(release.resolve)
        let armed = false
        first.remote.send = async (message, options) => { if (armed && ('result' in message || 'error' in message)) { armed = false; responseReady.resolve(); try { await release.promise; return await send(message, options) } finally { sendDone.resolve() } }; return send(message, options) }
        let name = 'write_register', args: Record<string, unknown> = writeArgs, applied = 0
        if (mode === 'group-response-loss') { name = 'create_group'; args = { device_id: device.id, name: 'synthetic repeated group', start_address: 10, quantity: 2 } }
        if (mode === 'device-response-loss') { name = 'create_device'; args = { name: 'synthetic repeated device', ip: 'new.mock.invalid' } }
        if (mode === 'guarded-response-loss') {
          name = 'update_register'; args = { register_id: register.id, alias: 'after', expected: body(await first.client.callTool({ name: 'get_register_edit_snapshot', arguments: { register_id: register.id } })).expected }
          const update = cfg.updateRegisterSettings.bind(cfg); cfg.updateRegisterSettings = (...input: Parameters<typeof update>) => { const result = update(...input); applied++; return result }
        }
        armed = true; const pending = outcome(first.client.callTool({ name, arguments: args })); await within(responseReady.promise)
        if (mode === 'group-response-loss') { assert.equal(cfg.listGroups(device.id).length, 2); assert.equal(cfg.listRegistersByObject(device.id).length, 3) }
        if (mode === 'device-response-loss') assert.equal(cfg.listObjects().length, 2)
        if (mode === 'guarded-response-loss') { assert.equal(cfg.getRegister(register.id)?.alias, 'after'); assert.equal(applied, 1) }
        await first.client.close(); assert((await within(pending)).error instanceof Error)
        release.resolve(); await within(sendDone.promise); await tick()
        const second = await open(), retry = await within(second.client.callTool({ name, arguments: args }))
        if (mode === 'group-response-loss') { assert.equal(retry.isError, undefined); assert.equal(cfg.listGroups(device.id).length, 3); assert.equal(cfg.listRegistersByObject(device.id).length, 5); console.log('MCP OUTCOME KNOWN LIMIT: explicit retry after lost create_group response creates a second group; no cross-session idempotency') }
        if (mode === 'device-response-loss') { assert.equal(retry.isError, true); assert.equal(cfg.listObjects().length, 2); console.log('MCP OUTCOME BOUNDARY: exact same-name create_device retry is rejected by name check, not an operation receipt') }
        if (mode === 'guarded-response-loss') { assert.equal(retry.isError, true); assert.equal(body(retry).status, 409); assert.equal(applied, 1); console.log('MCP OUTCOME BOUNDARY: old point snapshot retry conflicts after changed alias, no second application; not universal idempotency') }
      }
      console.log('MCP WRITE OUTCOME OK: ' + mode)
    } finally {
      finishWrite.resolve(); for (const release of releases) release(); http.createServer = create
      for (const peer of peers) { await peer.client.close(); await peer.sdk.close() }
      await ctx.fiber.dispose(); await cfg?.close().catch(() => {}); assert.equal(listener.closes, 1)
    }
  }
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', onUnhandled) }
console.log('MCP WRITE OUTCOME TEST OK: real SDK memory protocol and memory configuration, inert mock write counts only; known replay/uncertain-result limits remain, no hardware, real transport, user data or model')
