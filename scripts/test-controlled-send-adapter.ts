/** Isolated TCP/FC06 feasibility model. No exported production adapter or real I/O. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Duplex } from 'node:stream'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ModbusTCPClient } from 'jsmodbus'

if (process.argv.length !== 2) throw Error('No paths or options accepted')
type Plan = { id: string; version: number; slave: number; address: number; value: number; generation: number }
type Outcome = { state: 'completed' | 'not-sent' | 'unknown'; id?: string }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const pause = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const original = { connect: net.Socket.prototype.connect, listen: net.Server.prototype.listen, fetch: globalThis.fetch }
const deny = () => { throw Error('real I/O forbidden') }
net.Socket.prototype.connect = deny as typeof original.connect; net.Server.prototype.listen = deny as typeof original.listen; globalThis.fetch = deny as typeof original.fetch

class AdapterModel {
  private plans = new WeakMap<object, Plan>(); private used = new WeakSet<object>(); private tail: Promise<unknown> = Promise.resolve()
  private generation = 1; private wire: Duplex | null = null
  readonly frames: { id: string; generation: number; version: number; bytes: Buffer }[] = []
  // All hooks are fixture controls outside the SQLite send critical section.
  beforeSdk?: () => Promise<void>; afterAccepted?: () => void
  echo = true
  constructor(private db: DatabaseSync, private exclusive = false) {}
  prepare(value: number, functionCode = 6) {
    if (!this.exclusive || functionCode !== 6 || !Number.isInteger(value) || value < 0 || value > 65535) return null
    const row = this.db.prepare('SELECT version,slave,address FROM source WHERE id=1').get()!
    const token = Object.freeze({}); this.plans.set(token, { id: randomUUID(), version: Number(row.version), slave: Number(row.slave), address: Number(row.address), value, generation: this.generation }); return token
  }
  disconnect() { this.generation++; this.wire?.destroy() }
  submit(token: object, signal?: AbortSignal): Promise<Outcome> {
    const operation = this.tail.then(() => this.run(token, signal)); this.tail = operation.catch(() => {}); return operation
  }
  private async run(token: object, signal?: AbortSignal): Promise<Outcome> {
    const plan = this.plans.get(token)
    if (!plan || this.used.has(token)) return { state: 'not-sent' }
    this.used.add(token)
    if (signal?.aborted) return { state: 'not-sent', id: plan.id }
    const claim = this.db.prepare('UPDATE channel SET owner=? WHERE owner IS NULL').run(plan.id)
    if (claim.changes !== 1) return { state: 'not-sent', id: plan.id }
    let accepted = false, refused = false, settled = false
    const model = this
    // Private, operation-specific stream: no external SDK/OTA/raw writer can access this fixture stream.
    const wire = new class extends Duplex {
      override _read() {}
      override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        let owns = false
        try {
          model.db.exec('BEGIN IMMEDIATE'); owns = true
          const row = model.db.prepare('SELECT version,slave,address FROM source WHERE id=1').get()!
          const owner = model.db.prepare('SELECT owner FROM channel').get()!.owner
          if (accepted || settled || signal?.aborted || model.generation !== plan.generation || owner !== plan.id || row.version !== plan.version || row.slave !== plan.slave || row.address !== plan.address) throw Error('mock boundary refused')
          // Sole mock acceptance point, synchronous under the reservation; never await a device/response here.
          model.frames.push({ id: plan.id, generation: plan.generation, version: plan.version, bytes: Buffer.from(bytes) }); accepted = true
          model.db.exec('ROLLBACK'); owns = false
          callback()
          setImmediate(() => { model.afterAccepted?.(); if (model.echo && !this.destroyed) this.emit('data', Buffer.from(bytes)) })
        } catch {
          if (owns) model.db.exec('ROLLBACK')
          refused = !accepted; callback(Error('mock boundary refused'))
        }
      }
    }()
    wire.on('error', () => {}); this.wire = wire
    let outcome: Outcome
    try {
      await this.beforeSdk?.()
      if (wire.destroyed || signal?.aborted || this.generation !== plan.generation) { refused = true; throw Error('obsolete mock connection') }
      const sdk = new ModbusTCPClient(wire as unknown as net.Socket, plan.slave, 30)
      wire.emit('connect')
      await sdk.writeSingleRegister(plan.address, plan.value)
      outcome = { state: signal?.aborted || this.generation !== plan.generation ? 'unknown' : 'completed', id: plan.id }
    } catch { outcome = { state: accepted ? 'unknown' : refused ? 'not-sent' : 'unknown', id: plan.id } }
    finally { settled = true; wire.destroy(); if (this.wire === wire) this.wire = null }
    // Unknown outcomes retain the persistent owner as a fail-closed quarantine. No expiry/steal/retry.
    if (outcome.state !== 'unknown') this.db.prepare('UPDATE channel SET owner=NULL WHERE owner=?').run(plan.id)
    return outcome
  }
}
let passed = 0
async function fixture(name: string, action: (model: AdapterModel, db: DatabaseSync, file: string) => Promise<void>) {
  const base = resolve(tmpdir()), dir = mkdtempSync(join(base, 'probe-adapter-model-')), file = join(dir, 'synthetic.sqlite'), db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE source(id INTEGER PRIMARY KEY,version INTEGER,slave INTEGER,address INTEGER);INSERT INTO source VALUES(1,0,7,0);CREATE TABLE channel(owner TEXT);INSERT INTO channel VALUES(NULL);CREATE TRIGGER source_version AFTER UPDATE OF slave,address ON source BEGIN UPDATE source SET version=version+1 WHERE id=1;END')
    await action(new AdapterModel(db, true), db, file); passed++; console.log('CONTROLLED ADAPTER OK: ' + name)
  } finally { db.close(); const inside = relative(base, resolve(dir)); assert(inside.startsWith('probe-adapter-model-') && !inside.includes('/') && !inside.includes('\\')); rmSync(dir, { recursive: true }) }
}
function child(file: string, sql: string) {
  const result = spawnSync(process.execPath, ['-e', "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);try{d.exec(process.argv[2])}finally{d.close()}", file, sql], { encoding: 'utf8', timeout: 5000, windowsHide: true }); assert.equal(result.status, 0, result.stderr)
}
try {
  await fixture('capability defaults unavailable; unsupported commands are never prepared', async (_model, db) => { assert.equal(new AdapterModel(db).prepare(1), null); assert.equal(_model.prepare(1, 16), null); assert.equal(_model.prepare(-1), null); assert.equal(_model.frames.length, 0) })
  await fixture('actual SDK bytes bind immutable operation/unit/address/value', async model => {
    const plan = model.prepare(42)!; assert(Object.isFrozen(plan)); assert.equal((await model.submit(plan)).state, 'completed'); assert.equal(model.frames.length, 1)
    const bytes = model.frames[0].bytes; assert.equal(bytes[6], 7); assert.equal(bytes[7], 6); assert.equal(bytes.readUInt16BE(8), 0); assert.equal(bytes.readUInt16BE(10), 42)
    assert.equal((await model.submit(plan)).state, 'not-sent'); assert.equal((await model.submit({})).state, 'not-sent'); assert.equal(model.frames.length, 1)
  })
  await fixture('external ABA before final submission rejects with zero mock frames', async (model, _db, file) => { const plan = model.prepare(42)!; child(file, 'BEGIN IMMEDIATE;UPDATE source SET slave=9;UPDATE source SET slave=7;COMMIT'); assert.equal((await model.submit(plan)).state, 'not-sent'); assert.equal(model.frames.length, 0) })
  await fixture('configuration changes while waiting outside SDK reject at private stream boundary', async (model, _db, file) => {
    const step = pause(); model.beforeSdk = () => step.promise; const job = model.submit(model.prepare(42)!); await tick(); child(file, 'UPDATE source SET address=2'); step.release(); assert.equal((await job).state, 'not-sent'); assert.equal(model.frames.length, 0)
  })
  await fixture('foreign persistent owner is not stolen or expired', async (model, db, file) => { child(file, "UPDATE channel SET owner='foreign' WHERE owner IS NULL"); assert.equal((await model.submit(model.prepare(42)!)).state, 'not-sent'); assert.equal(db.prepare('SELECT owner FROM channel').get()!.owner, 'foreign'); assert.equal(model.frames.length, 0) })
  await fixture('other process cannot claim an in-flight owned channel; configuration is not locked until response', async (model, db, file) => {
    model.afterAccepted = () => child(file, "BEGIN IMMEDIATE;UPDATE channel SET owner='foreign' WHERE owner IS NULL;UPDATE source SET slave=9;COMMIT")
    assert.equal((await model.submit(model.prepare(42)!)).state, 'completed'); assert.equal(model.frames[0].bytes[6], 7); assert.equal(db.prepare('SELECT slave FROM source').get()!.slave, 9); assert.equal(db.prepare('SELECT owner FROM channel').get()!.owner, null)
  })
  await fixture('connection generation changes before SDK submission reject', async model => { const step = pause(); model.beforeSdk = () => step.promise; const job = model.submit(model.prepare(42)!); await tick(); model.disconnect(); step.release(); assert.equal((await job).state, 'not-sent'); assert.equal(model.frames.length, 0) })
  await fixture('lost channel ownership rejects without clearing another owner', async (model, db, file) => { const step = pause(); model.beforeSdk = () => step.promise; const job = model.submit(model.prepare(42)!); await tick(); child(file, "UPDATE channel SET owner='replacement'"); step.release(); assert.equal((await job).state, 'not-sent'); assert.equal(db.prepare('SELECT owner FROM channel').get()!.owner, 'replacement') })
  await fixture('identical SDK frames retain separate opaque operation identities', async model => { assert.equal((await model.submit(model.prepare(42)!)).state, 'completed'); assert.equal((await model.submit(model.prepare(42)!)).state, 'completed'); assert(model.frames[0].bytes.equals(model.frames[1].bytes)); assert.notEqual(model.frames[0].id, model.frames[1].id) })
  await fixture('response timeout is unknown and quarantines across new adapter instances', async (model, db) => { model.echo = false; const plan = model.prepare(42)!; assert.equal((await model.submit(plan)).state, 'unknown'); assert.equal((await model.submit(plan)).state, 'not-sent'); const other = new AdapterModel(db, true); assert.equal((await other.submit(other.prepare(1)!)).state, 'not-sent'); assert.equal(model.frames.length, 1); assert.equal(other.frames.length, 0); assert(db.prepare('SELECT owner FROM channel').get()!.owner) })
  await fixture('abort before admission emits nothing', async model => { assert.equal((await model.submit(model.prepare(42)!, AbortSignal.abort())).state, 'not-sent'); assert.equal(model.frames.length, 0) })
  await fixture('abort after acceptance never becomes a retryable not-sent result', async (model, db) => { const controller = new AbortController(); model.afterAccepted = () => controller.abort(); assert.equal((await model.submit(model.prepare(42)!, controller.signal)).state, 'unknown'); assert.equal(model.frames.length, 1); assert(db.prepare('SELECT owner FROM channel').get()!.owner) })
  await fixture('disconnect after acceptance is unknown and retains quarantine', async (model, db) => { model.afterAccepted = () => model.disconnect(); assert.equal((await model.submit(model.prepare(42)!)).state, 'unknown'); assert.equal(model.frames.length, 1); assert(db.prepare('SELECT owner FROM channel').get()!.owner) })
  await fixture('own queue keeps a stale second operation outside the SDK', async (model, _db, file) => {
    const first = model.prepare(11)!, second = model.prepare(22)!
    model.afterAccepted = () => child(file, 'UPDATE source SET slave=9')
    const results = await Promise.all([model.submit(first), model.submit(second)])
    assert.deepEqual(results.map(result => result.state), ['completed', 'not-sent']); assert.equal(model.frames.length, 1)
  })
  await fixture('cancellation while waiting outside SDK consumes the identity without emission or replay', async model => {
    const controller = new AbortController(), second = model.prepare(22)!
    model.afterAccepted = () => controller.abort()
    const results = await Promise.all([model.submit(model.prepare(11)!), model.submit(second, controller.signal)])
    assert.deepEqual(results.map(result => result.state), ['completed', 'not-sent']); assert.equal((await model.submit(second)).state, 'not-sent'); assert.equal(model.frames.length, 1)
  })
  console.log(`CONTROLLED ADAPTER TEST OK: ${passed} actual SDK/private memory stream/temporary SQLite groups. Exclusive TCP FC06 model only; no production safety capability.`)
} finally { net.Socket.prototype.connect = original.connect; net.Server.prototype.listen = original.listen; globalThis.fetch = original.fetch }
