/** Installed SDK + memory streams only. No application/driver startup or production send gate. */
import assert from 'node:assert/strict'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
import { ModbusTCPClient, ModbusRTUClient } from 'jsmodbus'

if (process.argv.slice(2).join(' ') !== '--mock') throw Error('Only --mock; no socket, serial port or database path is accepted.')
assert.equal((createRequire(import.meta.url)('jsmodbus/package.json') as { version: string }).version, '4.0.10', 'review the SDK audit before changing dependency versions')
type Result = { ok: true } | { ok: false; error: unknown }
const track = (promise: Promise<unknown>): Promise<Result> => promise.then(() => ({ ok: true }), error => ({ ok: false, error }))
const tick = () => new Promise<void>(done => setImmediate(done))
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_ok, fail) => { timer = setTimeout(() => fail(Error('audit deadline exceeded')), 1000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
class MemoryWire extends Duplex {
  readonly frames: Buffer[] = []; denied = 0; generation = 1; content = 'A'; gate = () => true
  constructor() { super(); this.on('error', () => {}) }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    // Candidate sink: synchronous check immediately before the sole simulated emit.
    if (!this.gate()) { this.denied++; callback(Error('mock send gate refused')); return }
    this.frames.push(Buffer.from(chunk)); callback()
  }
  echo(index: number) { this.emit('data', Buffer.from(this.frames[index])) }
}
type Client = ModbusTCPClient | ModbusRTUClient
function client(wire: MemoryWire, transport: 'tcp' | 'rtu', slaveId = 7): Client {
  const result = transport === 'tcp' ? new ModbusTCPClient(wire as unknown as net.Socket, slaveId, 100) : new ModbusRTUClient(wire, slaveId, 100)
  wire.emit(transport === 'tcp' ? 'connect' : 'open'); return result
}
/** Test ownership model only: no production lock exported or installed. */
class AuditLock {
  owner: string | null = null
  readonly waiters: { actor: string; grant: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = []
  acquire(actor: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted || this.owner === actor) return Promise.reject(Error('cancelled or reentrant acquisition'))
    if (this.owner === null) { this.owner = actor; return Promise.resolve(this.releaseFor(actor)) }
    return new Promise((grant, reject) => {
      const waiter = { actor, grant, reject, signal, abort: () => { const index = this.waiters.indexOf(waiter); if (index >= 0) { this.waiters.splice(index, 1); reject(Error('cancelled acquisition')) } } }
      this.waiters.push(waiter); signal?.addEventListener('abort', waiter.abort, { once: true })
    })
  }
  private releaseFor(actor: string) {
    let released = false
    return () => {
      if (released) return; released = true; assert.equal(this.owner, actor); this.owner = null
      const next = this.waiters.shift()
      if (next) { next.signal?.removeEventListener('abort', next.abort); this.owner = next.actor; next.grant(this.releaseFor(next.actor)) }
    }
  }
}
let cases = 0
async function check(name: string, run: () => Promise<void>) { await run(); cases++; console.log('SEND BOUNDARY OK: ' + name) }
const saved = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect, fetch: globalThis.fetch }
const deny = () => { throw Error('real I/O forbidden') }
net.Server.prototype.listen = deny as typeof saved.listen; net.Socket.prototype.connect = deny as typeof saved.connect; globalThis.fetch = deny as typeof saved.fetch
try {
  for (const transport of ['tcp', 'rtu'] as const) {
    await check(transport + ': actual SDK queue outlives an admission check', async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport), expected = wire.generation
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        assert.equal(wire.frames.length, 1); assert.equal(sdk.requestCount, 1)
        wire.generation++; assert.notEqual(wire.generation, expected)
        wire.echo(0); assert.equal(wire.frames.length, 2, 'SDK emits queued write after the version changed')
        wire.echo(1); assert((await bounded(first)).ok); assert((await bounded(second)).ok)
      } finally { wire.destroy() }
    })
    for (const mutation of ['changed', 'aba', 'unchanged'] as const) await check(transport + ': final mock sink generation/' + mutation, async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport), expected = wire.generation
      wire.gate = () => wire.generation === expected
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        if (mutation !== 'unchanged') { wire.generation++; wire.content = 'B' }
        if (mutation === 'aba') { wire.generation++; wire.content = 'A' }
        wire.echo(0); assert((await bounded(first)).ok)
        if (mutation === 'unchanged') { assert.equal(wire.frames.length, 2); wire.echo(1); assert((await bounded(second)).ok) }
        else { assert(!(await bounded(second)).ok); assert.equal(wire.frames.length, 1); assert.equal(wire.denied, 1) }
      } finally { wire.destroy() }
    })
    await check(transport + ': content-only send guard misses ABA', async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport), expected = wire.content
      wire.gate = () => wire.content === expected
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        wire.content = 'B'; wire.generation++; wire.content = 'A'; wire.generation++
        wire.echo(0); assert.equal(wire.frames.length, 2); wire.echo(1)
        assert((await bounded(first)).ok); assert((await bounded(second)).ok)
      } finally { wire.destroy() }
    })
    await check(transport + ': racing abort does not remove the SDK queued request', async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport), abort = new AbortController()
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        const cancelled = new Promise<'cancelled'>(done => abort.signal.addEventListener('abort', () => done('cancelled'), { once: true }))
        abort.abort(); assert.equal(await Promise.race([second, cancelled]), 'cancelled')
        assert.equal(sdk.requestCount, 1); wire.echo(0); assert.equal(wire.frames.length, 2, 'aborted waiter did not prevent later emission')
        wire.echo(1); assert((await bounded(first)).ok); assert((await bounded(second)).ok)
      } finally { wire.destroy() }
    })
    await check(transport + ': public manual rejection is not removal of all queued work', async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport)
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        sdk.manuallyClearRequests(2); assert(!(await bounded(first)).ok)
        assert.equal(sdk.requestCount, 1); wire.echo(0); assert.equal(wire.frames.length, 2)
        wire.echo(1); assert((await bounded(second)).ok)
      } finally { wire.destroy() }
    })
    await check(transport + ': close event compatibility and queue settlement', async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport)
      try {
        const first = track(sdk.writeSingleRegister(0, 11)), second = track(sdk.writeSingleRegister(1, 22))
        wire.destroy(); await tick()
        assert.equal(sdk.connectionState, transport === 'tcp' ? 'offline' : 'online')
        assert(!(await bounded(first)).ok); assert(!(await bounded(second)).ok)
        assert.equal(wire.frames.length, 1)
      } finally { wire.destroy() }
    })
    for (const changed of [false, true]) await check(transport + ': exclusive controlled admission/' + changed, async () => {
      const wire = new MemoryWire(), sdk = client(wire, transport), lock = new AuditLock(), expected = wire.generation
      const enqueue = async (actor: string, address: number) => {
        const release = await lock.acquire(actor)
        try { if (wire.generation !== expected) return 'not-admitted'; await sdk.writeSingleRegister(address, 42); return 'completed' }
        finally { release() }
      }
      try {
        const first = enqueue('first', 0), second = enqueue('second', 1); await tick()
        assert.equal(wire.frames.length, 1); assert.equal(sdk.requestCount, 0, 'controlled second task is outside the SDK queue')
        if (changed) wire.generation++
        wire.echo(0); await tick()
        if (!changed) { assert.equal(wire.frames.length, 2); wire.echo(1) }
        const results = await bounded(Promise.all([first, second]))
        assert.deepEqual(results, ['completed', changed ? 'not-admitted' : 'completed']); assert.equal(wire.frames.length, changed ? 1 : 2); assert.equal(lock.owner, null)
      } finally { wire.destroy() }
    })
  }
  await check('RTU: separate SDK unit clients do not provide a shared port lock', async () => {
    const wire = new MemoryWire(), a = client(wire, 'rtu', 7), b = client(wire, 'rtu', 9)
    try {
      const first = track(a.writeSingleRegister(0, 11)), second = track(b.writeSingleRegister(1, 22))
      assert.equal(wire.frames.length, 2, 'per-client queues do not serialize a shared RTU stream')
      // Let the SDK timers settle; do not pretend an echo broadcast proves unit routing.
      assert(!(await bounded(first)).ok); assert(!(await bounded(second)).ok)
    } finally { wire.destroy() }
  })
  await check('controlled queue can cancel before SDK admission with zero frames', async () => {
    const wire = new MemoryWire(), sdk = client(wire, 'tcp'), signal = AbortSignal.abort()
    try {
      const controlled = async () => { if (signal.aborted) return 'not-admitted'; await sdk.writeSingleRegister(0, 11); return 'sent' }
      assert.equal(await controlled(), 'not-admitted'); assert.equal(wire.frames.length, 0); assert.equal(sdk.requestCount, 0)
    } finally { wire.destroy() }
  })
  await check('identical RTU bytes do not identify an operation or configuration version', async () => {
    const wire = new MemoryWire(), sdk = client(wire, 'rtu')
    try {
      const first = track(sdk.writeSingleRegister(0, 42)); wire.echo(0); assert((await bounded(first)).ok)
      wire.generation++
      const second = track(sdk.writeSingleRegister(0, 42)); wire.echo(1); assert((await bounded(second)).ok)
      assert(wire.frames[0].equals(wire.frames[1]), 'a raw-frame lookup cannot distinguish these two versions')
    } finally { wire.destroy() }
  })
  await check('two real model-lock waits form a cycle; abort releases only the waiting acquisition', async () => {
    const configuration = new AuditLock(), channel = new AuditLock(), abort = new AbortController()
    const releaseConfiguration = await configuration.acquire('editor'), releaseChannel = await channel.acquire('writer')
    const writer = track(configuration.acquire('writer', abort.signal)), editor = channel.acquire('editor')
    assert.equal(configuration.owner, 'editor'); assert.equal(configuration.waiters[0].actor, 'writer')
    assert.equal(channel.owner, 'writer'); assert.equal(channel.waiters[0].actor, 'editor')
    abort.abort(); assert(!(await bounded(writer)).ok); assert.equal(channel.owner, 'writer', 'aborting a waiter must not release a held channel')
    releaseChannel(); const releaseEditorChannel = await bounded(editor); assert.equal(channel.owner, 'editor')
    releaseEditorChannel(); releaseConfiguration(); assert.equal(channel.owner, null); assert.equal(configuration.owner, null)
    assert.equal(configuration.waiters.length + channel.waiters.length, 0)
  })
  await check('model lock rejects reentrant acquisition and release is repeatable', async () => {
    const lock = new AuditLock(), release = await lock.acquire('writer')
    assert(!(await track(lock.acquire('writer'))).ok); release(); release(); assert.equal(lock.owner, null)
  })
  console.log(`WRITE SEND BOUNDARY AUDIT OK: ${cases} installed jsmodbus 4.0.10 + memory Duplex scenarios; mock final sink only, known ABA/queue/cancel/RTU-close gaps reproduced, no production lock/guard or physical transmission proof.`)
} finally { net.Server.prototype.listen = saved.listen; net.Socket.prototype.connect = saved.connect; globalThis.fetch = saved.fetch }
