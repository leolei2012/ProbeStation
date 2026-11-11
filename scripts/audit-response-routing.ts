/** Actual SDK + memory streams only; no production router or device operation. */
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import net from 'node:net'
import { ModbusTCPClient, ModbusRTUClient } from 'jsmodbus'

if (process.argv.slice(2).join(' ') !== '--mock') throw Error('Only --mock; no device or database arguments accepted')
assert.equal(createRequire(import.meta.url)('jsmodbus/package.json').version, '4.0.10', 'review SDK behavior after upgrade')
const original = { connect: net.Socket.prototype.connect, listen: net.Server.prototype.listen, fetch: globalThis.fetch }
const deny = () => { throw Error('real I/O forbidden') }
net.Socket.prototype.connect = deny as typeof original.connect; net.Server.prototype.listen = deny as typeof original.listen; globalThis.fetch = deny as typeof original.fetch
class Wire extends Duplex {
  last = Buffer.alloc(0); count = 0
  constructor() { super(); this.on('error', () => {}) }
  override _read() {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.last = Buffer.from(bytes); this.count++; done() }
}
const tracked = (promise: Promise<unknown>) => promise.then(() => ({ ok: true, reason: '' }), error => ({ ok: false, reason: String(error?.err ?? error?.message ?? error) }))
function client(wire: Wire, transport: 'tcp' | 'rtu', slave = 7) {
  const sdk = transport === 'tcp' ? new ModbusTCPClient(wire as unknown as net.Socket, slave, 1000) : new ModbusRTUClient(wire, slave, 1000)
  wire.emit(transport === 'tcp' ? 'connect' : 'open'); return sdk
}
async function echo(sdk: ModbusTCPClient | ModbusRTUClient, wire: Wire, value: number) { const pending = sdk.writeSingleRegister(0, value); const response = Buffer.from(wire.last); wire.emit('data', response); await pending; return response }
// Sources are trusted fixture transport objects, not an epoch field parsed from network bytes.
class GenerationBridge {
  private current = Symbol(); private seen = new WeakSet<EventEmitter>(); private detach: (() => void) | null = null
  drops = 0
  bind(source: EventEmitter, target: Wire) {
    if (this.seen.has(source)) throw Error('cannot declare a new connection generation on the same transport')
    this.seen.add(source); this.detach?.(); const generation = this.current = Symbol()
    const receive = (bytes: Buffer) => { if (this.current !== generation) { this.drops++; return }; target.emit('data', bytes) }
    source.on('data', receive); this.detach = () => source.off('data', receive)
    return receive // Fixture can exercise a callback already scheduled before detach.
  }
  close() { this.current = Symbol(); this.detach?.(); this.detach = null }
}
let cases = 0
async function check(name: string, run: () => Promise<void>) { await run(); cases++; console.log('RESPONSE ROUTING OK: ' + name) }
try {
  await check('fresh TCP client reuses ID and accepts a misrouted old write response', async () => {
    const a = new Wire(), b = new Wire()
    try { const old = await echo(client(a, 'tcp'), a, 11), next = client(b, 'tcp'), pending = tracked(next.writeSingleRegister(0, 22)); assert.equal(old.readUInt16BE(0), b.last.readUInt16BE(0)); b.emit('data', old); assert((await pending).ok) }
    finally { a.destroy(); b.destroy() }
  })
  await check('persistent TCP client rejects a delayed response with a different transaction ID', async () => {
    const wire = new Wire(), sdk = client(wire, 'tcp')
    try { const old = await echo(sdk, wire, 11), pending = tracked(sdk.writeSingleRegister(0, 22)); assert.notEqual(old.readUInt16BE(0), wire.last.readUInt16BE(0)); wire.emit('data', old); const result = await pending; assert(!result.ok); assert.equal(result.reason, 'OutOfSync') }
    finally { wire.destroy() }
  })
  await check('public TCP request sequence wraps and can accept an old same-ID response', async () => {
    const wire = new Wire(), sdk = client(wire, 'tcp')
    try {
      const old = await echo(sdk, wire, 11)
      // Exercise public methods, not private request counters. Retain only last frame for bounded memory.
      for (let index = 0; index < 65534; index++) await echo(sdk, wire, 11)
      const pending = tracked(sdk.writeSingleRegister(0, 22)); assert.equal(wire.count, 65536); assert.equal(wire.last.readUInt16BE(0), old.readUInt16BE(0)); wire.emit('data', old); assert((await pending).ok)
    } finally { wire.destroy() }
  })
  await check('public SDK filters valid-CRC RTU replies from another unit before request handling', async () => {
    const a = new Wire(), b = new Wire()
    try { const old = await echo(client(a, 'rtu', 7), a, 11), sdk = client(b, 'rtu', 9), pending = sdk.writeSingleRegister(0, 22); assert.equal(old[0], 7); assert.equal(b.last[0], 9); b.emit('data', old); b.emit('data', Buffer.from(b.last)); assert.equal((await pending).response.unitId, 9) }
    finally { a.destroy(); b.destroy() }
  })
  await check('same-unit RTU delayed duplicate has no transaction identity', async () => {
    const wire = new Wire(), sdk = client(wire, 'rtu')
    try { const old = await echo(sdk, wire, 11), pending = tracked(sdk.writeSingleRegister(0, 22)); assert.equal(old[0], wire.last[0]); wire.emit('data', old); assert((await pending).ok) }
    finally { wire.destroy() }
  })
  await check('recreated RTU client still cannot distinguish same-unit delayed response bytes', async () => {
    const a = new Wire(), current = new Wire()
    try {
      const stale = await echo(client(a, 'rtu', 7), a, 11); a.destroy(); const sdk = client(current, 'rtu', 7)
      const pending = tracked(sdk.writeSingleRegister(0, 22)); current.emit('data', stale); assert((await pending).ok)
    } finally { a.destroy(); current.destroy() }
  })
  await check('trusted connection generation drops old callbacks and handles current fragmented TCP response', async () => {
    const oldSource = new EventEmitter(), source = new EventEmitter(), old = new Wire(), current = new Wire(), bridge = new GenerationBridge()
    try {
      const oldReceive = bridge.bind(oldSource, old), oldSdk = client(old, 'tcp'), oldPending = tracked(oldSdk.writeSingleRegister(0, 11)), oldReply = Buffer.from(old.last)
      oldSource.emit('data', oldReply.subarray(0, 5))
      const sdk = client(current, 'tcp'); bridge.bind(source, current); old.destroy(); assert(!(await oldPending).ok)
      const pending = sdk.writeSingleRegister(0, 22), reply = Buffer.from(current.last)
      oldReceive(oldReply.subarray(5)); oldSource.emit('data', oldReply); assert.equal(bridge.drops, 1)
      source.emit('data', reply.subarray(0, 5)); source.emit('data', reply.subarray(5)); await pending
      assert.throws(() => bridge.bind(source, old), /same transport/)
    } finally { bridge.close(); old.destroy(); current.destroy() }
  })
  await check('a bridge cannot recognize old bytes mislabeled as the new trusted transport', async () => {
    const old = new Wire(), current = new Wire(), source = new EventEmitter(), bridge = new GenerationBridge()
    try { const stale = await echo(client(old, 'tcp'), old, 11), sdk = client(current, 'tcp'); bridge.bind(source, current); const pending = tracked(sdk.writeSingleRegister(0, 22)); source.emit('data', stale); assert((await pending).ok); assert.equal(bridge.drops, 0) }
    finally { bridge.close(); old.destroy(); current.destroy() }
  })
  console.log(`RESPONSE ROUTING AUDIT OK: ${cases} actual SDK/memory cases, including 65536 public TCP requests. Counterexamples remain unprotected; no production router, physical timing or hardware proof.`)
} finally { net.Socket.prototype.connect = original.connect; net.Server.prototype.listen = original.listen; globalThis.fetch = original.fetch }
