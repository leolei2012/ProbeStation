import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { createNativeBoundWire, executeBoundWrite } from '../packages/modbus/src/bound-write.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerWriteSource } from '../packages/core/src/guarded-register-write.ts'

// Loopback server is a synthetic device; no LAN IP, system serial path or user's database is used.
const cfg = new ConfigStore({ dbPath: ':memory:' }), sockets = new Set<net.Socket>(), received: Buffer[] = []
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  let bytes = Buffer.alloc(0)
  socket.on('data', part => {
    bytes = Buffer.concat([bytes, part]); if (bytes.length < 12) return
    received.push(Buffer.from(bytes))
    const reply = Buffer.from(bytes.subarray(0, 12)); reply.writeUInt16BE(6, 4)
    socket.write(reply.subarray(0, 5)); setImmediate(() => socket.end(reply.subarray(5)))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const d = cfg.createObject('loopback-only', '127.0.0.1', (server.address() as net.AddressInfo).port), g = cfg.createGroup(d.id, 'read', 3, 0x1000, 1, 'read', 7), r = cfg.createRegister(g.id, d.id, 'switch', 3, 0x1000, 'uint16')
  const operation = cfg.prepareRegisterWrite(r.id, 1, registerWriteSource(d, g, r)); cfg.claimRegisterWrite(operation.id)
  const result = await executeBoundWrite(operation.plan, send => cfg.acceptRegisterWrite(operation.plan, send), () => true)
  assert.equal(result.state, 'acknowledged', result.message)
  assert.equal(received.length, 1); assert.equal(received[0][6], 7); assert.equal(received[0][7], 6); assert.equal(received[0].readUInt16BE(8), 0x1000); assert.equal(received[0].readUInt16BE(10), 1)
  cfg.finishRegisterWrite(operation.id, result.state, result.message)
  class FakeSerial extends EventEmitter {
    isOpen = false; destroyed = false; writable = true; writableLength = 0; writes: Buffer[] = []; closes = 0
    constructor(readonly options: any) { super() }
    open(callback: (error?: Error) => void) { this.isOpen = true; setImmediate(callback) }
    flush(callback: (error?: Error) => void) { setImmediate(callback) }
    write(bytes: Buffer) { this.writes.push(Buffer.from(bytes)); setImmediate(() => this.emit('data', bytes)) }
    close(callback: (error?: Error) => void) { this.closes++; this.isOpen = false; setImmediate(callback) }
  }
  const ports: FakeSerial[] = []
  const constructors = { tcp: () => { throw Error('TCP not allowed in synthetic serial test') }, serial: (options: any) => { const port = new FakeSerial(options); ports.push(port); return port as any } }
  cfg.updateObject(d.id, { transport: 'rtu', serialPath: 'SYNTHETIC_ONLY', parity: 'none', timeoutMs: 100 })
  const serialPlan = cfg.prepareRegisterWrite(r.id, 0, registerWriteSource(cfg.getObject(d.id), g, r)); cfg.claimRegisterWrite(serialPlan.id)
  const serialResult = await executeBoundWrite(serialPlan.plan, send => cfg.acceptRegisterWrite(serialPlan.plan, send), () => true, plan => createNativeBoundWire(plan, constructors))
  assert.equal(serialResult.state, 'acknowledged'); assert.equal(ports[0].writes.length, 1); assert.equal(ports[0].closes, 1)
  assert.equal(ports[0].options.autoOpen, false); assert.equal(ports[0].options.lock, true); assert.equal(ports[0].writes[0].readUInt16BE(4), 0)
  console.log('BOUND NATIVE OK: real net.Socket FC06 0x1000 echo on ephemeral loopback, fragmented response, native serial adapter with injected port, exclusive/non-reconnecting/close behavior; no board or real serial I/O')
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await cfg.close()
}
