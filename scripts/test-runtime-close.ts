import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { Context } from 'cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SerialPort } from 'serialport'
import inject from 'light-my-request'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import * as importerPlugin from '../packages/importer/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as otaPlugin from '../packages/ota/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import * as slavePlugin from '../packages/slave/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target))
const originalListen = net.Server.prototype.listen, originalConnect = net.Socket.prototype.connect, originalFetch = globalThis.fetch
const serialOpen = SerialPort.prototype.open, serialWrite = SerialPort.prototype.write, serialList = SerialPort.list
const denied: string[] = [], block = (name: string) => () => { denied.push(name); throw new Error('unexpected real transport: ' + name) }
net.Server.prototype.listen = block('listen') as any; net.Socket.prototype.connect = block('connect') as any; globalThis.fetch = block('fetch') as any
SerialPort.prototype.open = block('serial.open') as any; SerialPort.prototype.write = block('serial.write') as any; SerialPort.list = block('serial.list') as any
try {
  for (const mode of ['normal', 'mcp-bind-failure', 'slave-close-failure'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'probestation-runtime-exit-')), ctx = new Context(), release = deferred(), exportEntered = deferred(), toolHandlers = new Map<string, Function>()
    const bindError = new Error('synthetic MCP bind failure'), slaveError = new Error('synthetic slave close failure')
    const servers: any[] = []; let disconnects = 0, cfg: any, store: any, app: any, sdk: McpServer | undefined
    const createHttp = http.createServer, createTcp = net.createServer, register = McpServer.prototype.registerTool
    try {
      await ctx.plugin(configPlugin, { dbPath: ':memory:' }); cfg = ctx.get('config', false)
      await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 60000, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 60000 }); store = ctx.get('store', false); await store.ready
      const device = cfg.createObject('synthetic runtime', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic words', 3, 0, 1)
      cfg.createRegister(group.id, device.id, 'synthetic word', 3, 0)
      await ctx.plugin({ name: 'modbus', apply(context: Context) {
        context.provide('modbus', { createDriver() {
          let connected = false
          return { async connect() { connected = true }, isConnected: () => connected, async disconnect() { connected = false; disconnects++ }, async readHoldingRegisters() { return [7] } }
        } })
      } })
      await ctx.plugin(sinkPlugin); await ctx.plugin(importerPlugin); await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 }); await ctx.plugin(otaPlugin, { dataDir: directory })
      const poller = ctx.get('poller', false), ota = ctx.get('ota', false), sink = ctx.get('sink', false)
      await poller.pollOnce({ id: device.id, host: 'mock.invalid', port: 502, groups: [group] })
      const beforeDisconnects = disconnects, retainedDriver = ctx.get('modbus', false).createDriver()
      await retainedDriver.connect(); poller.drivers.set('synthetic-shutdown-driver', retainedDriver)
      http.createServer = ((handler: any) => {
        const server = Object.assign(new EventEmitter(), {
          listening: false, closes: 0, handler,
          listen() { queueMicrotask(() => { if (mode === 'mcp-bind-failure') this.emit('error', bindError); else { this.listening = true; this.emit('listening') } }); return this },
          close(callback: (error?: Error) => void) { this.closes++; this.listening = false; queueMicrotask(() => callback()); return this },
        }); servers.push(server); return server
      }) as any
      try { await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 }) } finally { http.createServer = createHttp }
      net.createServer = (() => {
        const server = Object.assign(new EventEmitter(), { listening: false, closes: 0,
          listen(_port: number, _host: string, done: () => void) { this.listening = true; queueMicrotask(() => { this.emit('listening'); done() }); return this },
          close(done: (error?: Error) => void) { this.closes++; this.listening = false; queueMicrotask(() => done(mode === 'slave-close-failure' ? slaveError : undefined)); return this },
        }); servers.push(server); return server
      }) as any
      try { await ctx.plugin(slavePlugin, { port: 8502, holdingSize: 16 }) } finally { net.createServer = createTcp }
      await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: directory }); app = ctx.get('api', false); await app.ready(); await tick()
      assert.equal((await app.inject('/ready')).statusCode, 200)
      if (mode !== 'mcp-bind-failure') {
        const initialized = await inject(servers[0].handler, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } } })
        assert.equal(initialized.statusCode, 200); assert(initialized.headers['mcp-session-id'], 'actual SDK initialization uses only memory HTTP streams')
      }
      const busy = release.promise; ota.busy.set(1, busy)
      McpServer.prototype.registerTool = function (name: string, options: any, callback: any) { toolHandlers.set(name, callback); return register.call(this, name, options, callback) } as any
      try { sdk = ctx.get('mcp', false).createServer() } finally { McpServer.prototype.registerTool = register }
      sink.exportCsv = async () => { exportEntered.resolve(); await release.promise; assert(cfg.db.isOpen, 'configuration must outlive accepted MCP work'); return 'synthetic csv' }
      const exportWork = toolHandlers.get('export_history')!({ device_id: device.id, start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z', format: 'csv' })
      await exportEntered.promise
      const lateRequest = Object.assign(new EventEmitter(), { method: 'POST', headers: {} }), lateReply = { statusCode: 200, headersSent: false, ended: false, end() { this.ended = true } }
      servers[0].handler(lateRequest, lateReply)
      lateRequest.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } })))
      // Only this in-memory configuration and mock driver are visible; real transport guards remain active.
      poller.startAll(); assert.equal(poller.isRunning(), true)
      const timers = [store.flushTimer, store.retentionTimer], pollTimers = [poller.timer, poller.watchdogTimer].filter(Boolean), exit = ctx.fiber.dispose()
      await tick(); await tick(); assert(cfg.db.isOpen, 'root disposal must wait for both consumer barriers'); assert.equal(disconnects, beforeDisconnects, 'poller must wait for accepted OTA work before disconnecting')
      assert.equal(poller.isRunning(), false); assert(pollTimers.every((timer: any) => timer._destroyed), 'new mock acquisition must quiesce before waiting for accepted work')
      assert.throws(() => poller.startAll(), /closing or closed/)
      await assert.rejects(poller.pollOnce({ id: device.id, host: 'mock.invalid', port: 502, groups: [group] }), /closing or closed/)
      await assert.rejects(poller.getDriver(device), /closing or closed/)
      assert(timers.every(timer => timer._destroyed)); assert.equal(store.getSamplePersistenceStatus().available, false)
      await assert.rejects(toolHandlers.get('list_devices')!({}), /closing or closed/)
      release.resolve(); await exportWork; await exit
      assert.equal(cfg.db.isOpen, false); assert.equal(store.instance, null); assert.equal(disconnects, beforeDisconnects + 1); assert(servers.every(server => !server.listening))
      assert.equal(servers[0].closes, mode === 'mcp-bind-failure' ? 0 : 1); assert.equal(servers[1].closes, 1)
      assert.doesNotThrow(() => lateRequest.emit('end')); assert.equal(lateReply.statusCode, 503); assert.equal(lateReply.ended, true)
      await assert.rejects(app.inject('/ready')); await assert.rejects(app.inject('/health'))
      if (mode === 'normal') { await cfg.close(); await store.close() }
      else { const original = mode === 'mcp-bind-failure' ? bindError : slaveError; await assert.rejects(cfg.close(), error => contains(error, original)); await assert.rejects(store.close(), error => contains(error, original)) }
      await ctx.fiber.dispose(); assert.equal(disconnects, beforeDisconnects + 1)
    } finally {
      release.resolve(); http.createServer = createHttp; net.createServer = createTcp; McpServer.prototype.registerTool = register
      await ctx.fiber.dispose(); await sdk?.close(); await store?.close().catch(() => {}); await cfg?.close().catch(() => {})
      assert(directory.startsWith(join(tmpdir(), 'probestation-runtime-exit-'))); rmSync(directory, { recursive: true, force: true })
    }
  }
  assert.deepEqual(denied, [])
} finally { net.Server.prototype.listen = originalListen; net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; SerialPort.prototype.open = serialOpen; SerialPort.prototype.write = serialWrite; SerialPort.list = serialList }
console.log('RUNTIME CLOSE OK: real config/store/poller/Sink/importer/OTA/MCP/slave/API with mock drivers/listeners; concurrent root waits accepted MCP/OTA work, closes timers/connections/endpoints, preserves bind/cleanup errors and repeats safely; no OS listeners, devices, user data or model calls')
