import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const within = async <T,>(work: PromiseLike<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lifecycle timeout: ' + label)), 4000) })]) }
  finally { clearTimeout(timer) }
}
class Socket extends EventEmitter {
  readyState = 1; terminated = 0; messages: string[] = []
  constructor(private readonly fail = false) { super() }
  send(message: string) { this.messages.push(message) }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close'); if (this.fail) throw new Error('synthetic terminate failure') }
}
const failures: unknown[] = [], unhandled = (error: unknown) => { failures.push(error) }
process.on('unhandledRejection', unhandled)
try {
  for (const mode of ['normal', 'early-dispose', 'invalid-settings', 'route-failure'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'probestation-api-exit-')), ctx = new Context(), apiTimers: NodeJS.Timeout[] = []
    if (mode === 'invalid-settings') writeFileSync(join(directory, 'ai-settings.json'), '{synthetic invalid json')
    await ctx.plugin(configPlugin, { dbPath: ':memory:' })
    await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
    await ctx.plugin({ name: 'inert-api-exit-services', apply(context: Context) { for (const name of ['poller', 'sink', 'importer', 'ota']) context.provide(name as any, {} as any) } })
    const cfg = ctx.get('config', false) as any, store = ctx.get('store', false) as any, originalInterval = globalThis.setInterval
    let app: any, ws: ((socket: Socket) => void) | undefined
    const sockets: Socket[] = []
    try {
      await store.ready; await store.mutations
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { const timer = originalInterval(...args); apiTimers.push(timer); return timer }) as typeof setInterval
      try { await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: directory }) }
      finally { globalThis.setInterval = originalInterval }
      app = ctx.get('api', false); assert(app); assert.equal(apiTimers.length, 1)
      app.addHook('onRoute', (route: any) => {
        if (route.url !== '/ws' || !route.websocket) return
        if (mode === 'route-failure') throw new Error('synthetic route registration failure')
        ws = route.handler
      })
      if (mode === 'invalid-settings' || mode === 'route-failure') {
        await assert.rejects(app.ready(), mode === 'invalid-settings' ? /AI 配置/ : /synthetic route/)
        assert(apiTimers.every(timer => (timer as any)._destroyed), mode + ': failed bootstrap must clear its sweep before owner disposal')
      }
      else if (mode === 'normal') {
        await app.ready(); assert.equal((await app.inject('/ready')).statusCode, 200)
        assert(ws, 'capture the actual WebSocket route callback without opening a socket')
        sockets.push(new Socket(true), new Socket())
        for (const socket of sockets) { ws(socket); assert.equal(socket.messages.length, 3) }
      }
      await within(ctx.fiber.dispose(), 'root dispose ' + mode)
      assert(apiTimers.every(timer => (timer as any)._destroyed), mode + ': API sweep must be cleared even if bootstrap never reached its onClose registration')
      await assert.rejects(app.inject('/ready'), mode + ': a disposed API must stop accepting new readiness requests')
      await assert.rejects(app.inject('/health'), mode + ': HTTP resources must actually close')
      for (const socket of sockets) assert.equal(socket.terminated, 1, 'all retained sockets are terminated once despite another termination throwing')
      const sent = sockets.map(socket => socket.messages.length)
      ;(ctx as any).emit('poller/result', { objectId: 1, points: [] })
      assert.deepEqual(sockets.map(socket => socket.messages.length), sent, 'disposed event relays must not send')
      await within(ctx.fiber.dispose(), 'repeat dispose')
      for (const socket of sockets) assert.equal(socket.terminated, 1)
    } finally {
      globalThis.setInterval = originalInterval
      await ctx.fiber.dispose()
      await app?.close().catch(() => {}) // The deliberately failed bootstrap may reject close too.
      for (const timer of apiTimers) clearInterval(timer)
      await store.mutations; const connection = await store.ready.catch(() => null); connection?.closeSync(); store.instance?.closeSync(); cfg.db.close()
      assert(directory.startsWith(join(tmpdir(), 'probestation-api-exit-')))
      rmSync(directory, { recursive: true, force: true })
    }
  }
  await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(failures, [])
} finally { process.off('unhandledRejection', unhandled) }
console.log('API LIFECYCLE OK: actual Cordis root disposal, early shutdown and real bootstrap failures clear sweeps/close Fastify, stop readiness/health admission, terminate retained mock sockets and detach relays idempotently; memory data only, no listeners/hardware/models')
