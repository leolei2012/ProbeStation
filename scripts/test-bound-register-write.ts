import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerWriteSource, type GuardedWritePlan } from '../packages/core/src/guarded-register-write.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { executeBoundWrite, writeCrc, type BoundWire } from '../packages/modbus/src/bound-write.ts'
import { apply as pollerPlugin } from '../packages/poller/src/index.ts'

// All wire access is synthetic. Neither the native transport nor the real CLI is started.
const frames: Buffer[] = []
let beforeOpen: (() => void) | undefined, beforeAccept: (() => void) | undefined
let echo = true, corrupt = false, connectionFailure = false, acceptedHook: (() => void) | undefined
function factory(plan: GuardedWritePlan): BoundWire {
  const events = new EventEmitter()
  let open = false
  return { events,
    async open() { beforeOpen?.(); if (connectionFailure) throw Error('synthetic open failure'); open = true },
    ready: () => open,
    write(frame) {
      frames.push(Buffer.from(frame)); if (acceptedHook) setImmediate(acceptedHook)
      if (echo) setImmediate(() => {
        const tcp = plan.source.device.transport === 'tcp'
        let reply = tcp ? Buffer.from(frame.subarray(0, 12)) : Buffer.from(frame.subarray(0, 6))
        if (tcp) reply.writeUInt16BE(6, 4)
        else { const crc = Buffer.alloc(2); crc.writeUInt16LE(writeCrc(reply)); reply = Buffer.concat([reply, crc]) }
        if (corrupt) reply[0] ^= 1
        // fragmented native input must still match the one operation's response
        events.emit('data', reply.subarray(0, 3)); events.emit('data', reply.subarray(3))
      })
    }, async close() { open = false },
  }
}
const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify()
const d = cfg.createObject('压缩机', '192.0.2.25', 502)
const g = cfg.createGroup(d.id, '开关（读分组）', 3, 0x1000, 8, 'read', 7)
const r = cfg.createRegister(g.id, d.id, '压缩机开关', 3, 0x1000, 'uint16')
let engine: any
const events = new Map<string, Function[]>(), opts = { pollIntervalMs: 1000, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 }
const ctx: any = { config: cfg, store: {}, modbus: { executeBoundWrite(plan: GuardedWritePlan, accept: (send: () => void) => void, current: () => boolean) { return executeBoundWrite(plan, send => { beforeAccept?.(); accept(send) }, current, factory) } },
  on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]) }, provide(_name: string, value: any) { engine = value }, logger: () => ({ info() {}, warn() {} }) }
pollerPlugin(ctx, opts)
registerRegisterWrite(app, cfg, engine)
const headers = { 'x-probestation-write': '1' }
const source = () => registerWriteSource(cfg.getObject(d.id), cfg.getGroup(g.id), cfg.getRegister(r.id))
async function prepare(value: unknown = '1', expected: any = source()) {
  const res = await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, headers, payload: { version: 1, value, source: expected } })
  assert.equal(res.statusCode, 200, res.body); return res.json()
}
const execute = (id: string, body: any = { version: 1 }) => app.inject({ method: 'POST', url: `/api/register-writes/${id}/execute`, headers, payload: body })
try {
  assert.equal((await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, payload: { version: 1, value: 1, source: source() } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write`, payload: { value: 1 } })).statusCode, 503)
  const first = await prepare()
  assert.equal(frames.length, 0, 'prepare cannot emit any frame')
  assert.deepEqual(first.plan.words, [1]); assert.equal(first.plan.functionCode, 6)
  let pollingCloses = 0
  engine.drivers.set('tcp:' + d.id, { async disconnect() { pollingCloses++ } })
  beforeOpen = () => { assert.equal(pollingCloses, 1, 'single-client TCP polling handle is released before opening command handle') }
  const sent = await execute(first.id)
  beforeOpen = undefined
  assert.equal(sent.json().state, 'acknowledged', sent.body)
  assert.equal(frames.length, 1)
  assert.equal(frames[0][6], 7); assert.equal(frames[0][7], 6); assert.equal(frames[0].readUInt16BE(8), 0x1000); assert.equal(frames[0].readUInt16BE(10), 1)
  assert.equal((await execute(first.id)).json().state, 'acknowledged'); assert.equal(frames.length, 1, 'replay returns receipt without resending')
  const cancel = (id: string) => app.inject({ method: 'POST', url: `/api/register-writes/${id}/cancel`, headers, payload: { version: 1 } })
  assert.equal((await cancel(first.id)).json().state, 'acknowledged', 'completed commands cannot be cancelled retroactively')
  const cancelled = await prepare()
  assert.equal((await cancel(cancelled.id)).json().state, 'not-sent')
  assert.equal((await execute(cancelled.id)).json().state, 'not-sent', 'late execute after cancelling a prepared command cannot send')
  assert.equal(frames.length, 1)
  const off = await prepare('0'); assert.equal((await execute(off.id)).json().state, 'acknowledged'); assert.equal(frames.at(-1)!.readUInt16BE(10), 0)
  const before = frames.length
  const waiting = await prepare()
  engine.inflight.set('tcp:' + d.id, 1)
  const waitingRequest = execute(waiting.id)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(frames.length, before, 'a command cannot overtake an in-flight read')
  assert.equal((await cancel(waiting.id)).json().state, 'sending', 'cancellation cannot claim that an admitted command was not sent')
  cfg.updateRegister(r.id, { alias: '队列期间变化' }); engine.inflight.delete('tcp:' + d.id)
  assert.equal((await waitingRequest).json().state, 'not-sent'); assert.equal(frames.length, before)
  const stale = await prepare(); cfg.updateGroup(g.id, { slaveId: 9 }); cfg.updateGroup(g.id, { slaveId: 7 })
  assert.equal((await execute(stale.id)).statusCode, 409); assert.equal(frames.length, before, 'ABA cannot reuse a confirmation')
  const oldSource = source(); cfg.updateRegister(r.id, { dataType: 'int16' })
  assert.equal((await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, headers, payload: { version: 1, value: 1, source: oldSource } })).statusCode, 409)
  cfg.updateRegister(r.id, { dataType: 'uint16' })
  const queued = await prepare(); beforeOpen = () => cfg.updateObject(d.id, { ip: '192.0.2.26' })
  assert.equal((await execute(queued.id)).json().state, 'not-sent'); assert.equal(frames.length, before); beforeOpen = undefined
  const gate = await prepare(); beforeAccept = () => cfg.updateGroup(g.id, { slaveId: 9 })
  assert.equal((await execute(gate.id)).json().state, 'not-sent'); assert.equal(frames.length, before); beforeAccept = undefined
  const reconnect = await prepare(); beforeOpen = () => { void engine.reconnectDevice(d.id) }
  assert.equal((await execute(reconnect.id)).json().state, 'not-sent'); assert.equal(frames.length, before); beforeOpen = undefined
  const fail = await prepare(); connectionFailure = true
  assert.equal((await execute(fail.id)).json().state, 'not-sent'); connectionFailure = false
  const changeAfter = await prepare(); acceptedHook = () => cfg.updateGroup(g.id, { name: '发送后变更' })
  assert.equal((await execute(changeAfter.id)).json().state, 'acknowledged', 'configuration edits after native submission do not undo that command'); acceptedHook = undefined
  cfg.updateObject(d.id, { timeoutMs: 100 })
  const lost = await prepare(); echo = false
  const result = await execute(lost.id); assert.equal(result.json().state, 'unknown', result.body)
  const afterLost = frames.length
  assert.equal((await execute(lost.id)).json().state, 'unknown'); assert.equal(frames.length, afterLost)
  assert.equal((await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, headers, payload: { version: 1, value: 0, source: source() } })).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/api/register-writes/${lost.id}/review-unknown`, headers, payload: { confirmedOnSite: true } })).json().state, 'reviewed-unknown')
  echo = true
  for (const value of ['', true, {}, 1.5, -1, 65536]) {
    const res = await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, headers, payload: { version: 1, value, source: source() } })
    assert.equal(res.statusCode, 400, res.body)
  }
  cfg.updateRegister(r.id, { dataType: 'uint32-LE' })
  const wide = await prepare('65538'); assert.equal(wide.plan.functionCode, 16); assert.deepEqual(wide.plan.words, [2, 1])
  assert.equal((await execute(wide.id)).json().state, 'acknowledged'); assert.equal(frames.at(-1)![7], 16)
  cfg.updateObject(d.id, { transport: 'rtu', serialPath: 'COM77', baudRate: 9600 })
  const rtu = await prepare('65538')
  assert.equal((await execute(rtu.id)).json().state, 'acknowledged'); assert.equal(frames.at(-1)![0], 9); assert.equal(frames.at(-1)![1], 16)
  const bad = await prepare(); corrupt = true
  assert.equal((await execute(bad.id)).json().state, 'unknown'); corrupt = false
  const tamper = await execute(wide.id, { version: 1, value: 0 }); assert.equal(tamper.statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: `/api/registers/${r.id}/write/prepare`, headers: { ...headers, origin: 'https://elsewhere.example' }, payload: { version: 1, value: 1, source: source() } })).statusCode, 403)
  console.log('BOUND REGISTER WRITE OK: real API/config/poller/private transport with fake wire; FC06 0x1000 0/1, FC16 LE, TCP/RTU, prepare-only, source/ABA/queue/connect/final-gate checks, replay, unknown quarantine, no firmware or physical I/O')
} finally { await app.close(); await engine.stopAll(); await cfg.close() }

const base = resolve(tmpdir()), dir = mkdtempSync(join(base, 'probe-bound-write-')), path = join(dir, 'synthetic.db')
let memory = new ConfigStore({ dbPath: path })
try {
  const d = memory.createObject('multiwriter', '192.0.2.1', 502), g = memory.createGroup(d.id, 'g', 3, 0x1000, 1, 'read', 1), r = memory.createRegister(g.id, d.id, 'r', 3, 0x1000, 'uint16')
  const getSource = () => registerWriteSource(memory.getObject(d.id), memory.getGroup(g.id), memory.getRegister(r.id))
  const ticket = memory.prepareRegisterWrite(r.id, 1, getSource())
  const other = new DatabaseSync(path)
  other.exec('UPDATE register_groups SET slave_id=2; UPDATE register_groups SET slave_id=1;')
  assert.throws(() => memory.claimRegisterWrite(ticket.id), /配置已变化/)
  const pending = memory.prepareRegisterWrite(r.id, 1, getSource()); memory.claimRegisterWrite(pending.id)
  memory.acceptRegisterWrite(pending.plan, () => {
    assert.throws(() => other.exec('UPDATE register_groups SET slave_id=2'), /locked/)
  })
  other.close(); await memory.close(); memory = new ConfigStore({ dbPath: path })
  assert.equal(memory.getRegisterWrite(pending.id).state, 'unknown', 'process/lifecycle restart never retries a pending command')
  assert.equal(memory.claimRegisterWrite(pending.id).claimed, false)
  assert.throws(() => memory.prepareRegisterWrite(r.id, 0, getSource()), /结果未知/)
  memory.reviewUnknownRegisterWrite(pending.id)
  const beforeReopen = memory.prepareRegisterWrite(r.id, 0, getSource()); memory.reopen(path)
  assert.throws(() => memory.claimRegisterWrite(beforeReopen.id), /配置已变化/)
  console.log('BOUND GENERATION OK: persisted SQLite triggers, external-writer ABA, synchronous send exclusion, reopen invalidation and restart unknown outcomes')
} finally { await memory.close(); const inside = relative(base, dir); assert(inside.startsWith('probe-bound-write-') && !inside.includes('/') && !inside.includes('\\')); rmSync(dir, { recursive: true }) }
