/** Design proof only. Candidate routes/driver below are never registered by the application. */
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { parseRegisterWriteValue } from '../packages/core/src/register-write-value.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'

if (process.argv.slice(2).join(' ') !== '--mock') throw Error('Only --mock is accepted; no addresses or file databases.')
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type Phase = 'queue' | 'connect' | 'driver-queue' | 'after-send'
type Plan = Readonly<{ scope: symbol; version: number; runtime: number; graph: string; pointId: number; deviceId: number; slaveId: number; address: number; dataType: string; connection: string; words: readonly number[] }>
type Ticket = { plan: Plan; expires: number; state: 'offered' | 'accepted' }
const stopped = () => { throw Object.assign(Error('mock source/version unavailable or changed'), { statusCode: 409 }) }
let cases = 0
async function fixture(run: (h: ReturnType<typeof model>) => Promise<void>, transport = 'tcp') {
  const h = model(transport)
  try { await run(h); cases++ } finally { await h.app.close(); await h.cfg.close() }
}
function model(transport: string) {
  let version = 0, runtime = 0, now = 0, observed = true, supported = true
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (observed) version++ })
  const device = cfg.createObject('mock only', 'before.mock.invalid', 502, 'master', { transport, serialPath: transport === 'rtu' ? 'MOCK-ONLY' : null })
  const group = cfg.createGroup(device.id, 'mock only', 3, 0, 4, 'read', 7), point = cfg.createRegister(group.id, device.id, 'mock only', 3, 0, 'uint16')
  const app = Fastify(), tickets = new Map<string, Ticket>(), frames: Plan[] = [], phases: Phase[] = []
  const hooks = { phase: async (_phase: Phase) => {}, skipFinalCheck: false, wrongBinding: false, responseLost: false }
  function snapshot() {
    const reg = cfg.getRegister(point.id)
    if (!reg) return stopped()
    const graph = cfg.getGroupSettings(reg.groupId), p = graph.registers.find(p => p.id === point.id)
    if (!p || p.objectId !== graph.device.id || graph.group.objectId !== graph.device.id || graph.device.mode !== 'master' || p.functionCode !== 3) return stopped()
    return { graph, point: p }
  }
  const binding = (d: ReturnType<typeof snapshot>['graph']['device']) => JSON.stringify(d.transport === 'rtu'
    ? ['rtu', d.serialPath, d.baudRate, d.parity, d.dataBits, d.stopBits, d.flowControl]
    : ['tcp', d.ip, d.port])
  function check(plan: Plan) {
    if (!supported || plan.scope !== cfg.getRecordingIntervalScope() || plan.version !== version || plan.runtime !== runtime) return stopped()
    const current = snapshot()
    if (current.graph.revision !== plan.graph || binding(current.graph.device) !== plan.connection || current.graph.group.slaveId !== plan.slaveId || current.point.startAddress !== plan.address || current.point.dataType !== plan.dataType) return stopped()
  }
  async function phase(name: Phase) { phases.push(name); await hooks.phase(name) }
  app.post('/candidate/confirm', async (req, reply) => {
    if (!supported) return reply.code(503).send({ code: 'MOCK_UNSUPPORTED' })
    const body = req.body as { value?: unknown }, current = snapshot()
    const words = encodeRegister(current.point.dataType, parseRegisterWriteValue(current.point.dataType, body?.value))
    const plan: Plan = Object.freeze({ scope: cfg.getRecordingIntervalScope(), version, runtime, graph: current.graph.revision, pointId: point.id, deviceId: device.id, slaveId: current.graph.group.slaveId, address: current.point.startAddress, dataType: current.point.dataType, connection: binding(current.graph.device), words: Object.freeze([...words]) })
    const token = randomUUID(); tickets.set(token, { plan, expires: now + 60000, state: 'offered' })
    return { token, version, target: { deviceId: plan.deviceId, slaveId: plan.slaveId, address: plan.address, dataType: plan.dataType }, words: [...plan.words], simulationOnly: true }
  })
  app.post('/candidate/send', async (req, reply) => {
    const body = req.body as { token?: unknown }, token = typeof body?.token === 'string' ? body.token : '', ticket = tickets.get(token)
    if (!ticket || ticket.state !== 'offered' || now >= ticket.expires || Object.keys(body).some(key => key !== 'token')) return reply.code(409).send({ code: 'MOCK_NOT_ADMITTED', outcome: 'not-sent' })
    // Single use is a candidate safety choice, not a promise that legacy writes are idempotent.
    ticket.state = 'accepted'; let sent = false
    try {
      check(ticket.plan); await phase('queue'); check(ticket.plan)
      // Connection is created from the immutable expected plan, never refreshed to a different target.
      await phase('connect'); check(ticket.plan)
      const driverBinding = hooks.wrongBinding ? 'other.mock.invalid' : ticket.plan.connection
      if (driverBinding !== ticket.plan.connection) return stopped()
      await phase('driver-queue')
      // Only the model sink has this boundary: no await or application callback between check and emit.
      if (!hooks.skipFinalCheck) check(ticket.plan)
      sent = true; frames.push(ticket.plan)
      await phase('after-send')
      if (hooks.responseLost) throw Error('synthetic response lost')
      return { outcome: 'completed', simulationOnly: true }
    } catch {
      return reply.code(sent ? 502 : 409).send({ code: sent ? 'MOCK_OUTCOME_UNKNOWN' : 'MOCK_NOT_SENT', outcome: sent ? 'unknown' : 'not-sent', simulationOnly: true })
    }
  })
  return { app, cfg, device, group, point, hooks, frames, phases,
    confirm: () => app.inject({ method: 'POST', url: '/candidate/confirm', payload: { value: 42 } }),
    send: (token: string) => app.inject({ method: 'POST', url: '/candidate/send', payload: { token } }),
    reconnect() { runtime++ }, expire() { now = 60000 }, unsupported() { supported = false }, suppressObservation() { observed = false } }
}
const saved = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect, fetch: globalThis.fetch }
const deny = () => { throw Error('real I/O is forbidden in this model audit') }
net.Server.prototype.listen = deny as typeof saved.listen; net.Socket.prototype.connect = deny as typeof saved.connect; globalThis.fetch = deny as typeof saved.fetch
try {
  for (const transport of ['tcp', 'rtu']) {
    await fixture(async h => {
      const offer = (await h.confirm()).json(); assert.deepEqual(offer.target, { deviceId: h.device.id, slaveId: 7, address: 0, dataType: 'uint16' }); assert.deepEqual(offer.words, [42])
      assert.equal(h.frames.length, 0); assert.equal((await h.send(offer.token)).statusCode, 200)
      assert.equal(h.frames.length, 1); assert.deepEqual(h.frames[0].words, [42]); assert.equal((await h.send(offer.token)).statusCode, 409); assert.equal(h.frames.length, 1)
    }, transport)
    for (const stage of ['confirmation', 'queue', 'connect', 'driver-queue'] as const) for (const change of ['slave', 'address', 'type', 'endpoint', 'aba', 'runtime'] as const) {
      await fixture(async h => {
        const offer = (await h.confirm()).json(), entered = deferred(), release = deferred()
        const mutate = () => {
          if (change === 'slave') h.cfg.updateGroup(h.group.id, { slaveId: 9 })
          if (change === 'address') h.cfg.updateRegister(h.point.id, { startAddress: 1 })
          if (change === 'type') h.cfg.updateRegister(h.point.id, { dataType: 'uint32-LE' })
          if (change === 'endpoint') h.cfg.updateObject(h.device.id, transport === 'rtu' ? { serialPath: 'MOCK-NEW' } : { ip: 'after.mock.invalid' })
          if (change === 'aba') { h.cfg.updateGroup(h.group.id, { slaveId: 9 }); h.cfg.updateGroup(h.group.id, { slaveId: 7 }) }
          if (change === 'runtime') h.reconnect()
        }
        if (stage === 'confirmation') mutate()
        else h.hooks.phase = async name => { if (name === stage) { entered.resolve(); await release.promise } }
        const pending = h.send(offer.token)
        try {
          if (stage !== 'confirmation') { await entered.promise; mutate(); release.resolve() }
          const response = await pending; assert.equal(response.statusCode, 409, transport + '/' + stage + '/' + change); assert.equal(response.json().outcome, 'not-sent'); assert.equal(h.frames.length, 0)
        } finally { release.resolve() }
      }, transport)
    }
  }
  for (const change of ['expired', 'reopen', 'deleted', 'unsupported', 'binding'] as const) await fixture(async h => {
    const offer = (await h.confirm()).json()
    if (change === 'expired') h.expire()
    if (change === 'reopen') h.cfg.reopen(':memory:')
    if (change === 'deleted') h.cfg.deleteRegister(h.point.id)
    if (change === 'unsupported') h.unsupported()
    if (change === 'binding') h.hooks.wrongBinding = true
    assert.equal((await h.send(offer.token)).statusCode, 409); assert.equal(h.frames.length, 0)
  })
  await fixture(async h => {
    const offer = (await h.confirm()).json(), entered = deferred(), release = deferred()
    h.hooks.phase = async name => { if (name === 'queue') { entered.resolve(); await release.promise } }
    const first = h.send(offer.token); await entered.promise
    assert.equal((await h.send(offer.token)).statusCode, 409); assert.equal(h.frames.length, 0)
    release.resolve(); assert.equal((await first).statusCode, 200); assert.equal(h.frames.length, 1)
  })
  await fixture(async h => {
    const offer = (await h.confirm()).json(); h.hooks.responseLost = true
    const response = await h.send(offer.token); assert.equal(response.statusCode, 502); assert.equal(response.json().outcome, 'unknown'); assert.equal(h.frames.length, 1)
    assert.equal((await h.send(offer.token)).statusCode, 409); assert.equal(h.frames.length, 1)
  })
  await fixture(async h => {
    const offer = (await h.confirm()).json(); h.hooks.phase = async name => { if (name === 'after-send') h.cfg.updateGroup(h.group.id, { slaveId: 9 }) }
    assert.equal((await h.send(offer.token)).statusCode, 200); assert.equal(h.frames[0].slaveId, 7, 'later changes cannot retrospectively revoke an emitted frame')
  })
  await fixture(async h => {
    const offer = (await h.confirm()).json()
    const response = await h.app.inject({ method: 'POST', url: '/candidate/send', payload: { token: offer.token, value: 99, slaveId: 9 } })
    assert.equal(response.statusCode, 409); assert.equal(h.frames.length, 0, 'send cannot substitute values or sources after confirmation')
    assert.equal((await h.send('forged')).statusCode, 409); assert.equal(h.frames.length, 0)
  })
  await fixture(async h => {
    h.cfg.updateObject(h.device.id, { mode: 'slave', ip: '0.0.0.0' })
    assert.equal((await h.confirm()).statusCode, 409); assert.equal(h.frames.length, 0, 'unmodelled local memory writes must not silently enter the external-write candidate')
  })
  await fixture(async h => {
    const offer = (await h.app.inject({ method: 'POST', url: '/candidate/confirm', payload: { value: 0 } })).json()
    assert.deepEqual(offer.words, [0]); assert.equal((await h.send(offer.token)).statusCode, 200); assert.deepEqual(h.frames[0].words, [0])
  })
  // Counterexamples are expected failures of weaker designs; never report these as protected paths.
  await fixture(async h => {
    const offer = (await h.confirm()).json(); h.hooks.skipFinalCheck = true
    h.hooks.phase = async name => { if (name === 'driver-queue') h.cfg.updateGroup(h.group.id, { slaveId: 9 }) }
    assert.equal((await h.send(offer.token)).statusCode, 200); assert.equal(h.frames.length, 1)
    console.log('KNOWN GAP: checking only before an internal driver queue admits an obsolete version.')
  })
  await fixture(async h => {
    const offer = (await h.confirm()).json(); h.suppressObservation()
    h.cfg.updateGroup(h.group.id, { slaveId: 9 }); h.cfg.updateGroup(h.group.id, { slaveId: 7 })
    assert.equal((await h.send(offer.token)).statusCode, 200); assert.equal(h.frames.length, 1)
    console.log('KNOWN GAP: unobserved ABA defeats content hashes plus process-local notification versions; external writers need an authoritative revision.')
  })
  await fixture(async h => {
    let legacyWrites = 0
    registerRegisterWrite(h.app, h.cfg, { async write() { legacyWrites++ } })
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/registers/' + h.point.id + '/write', payload: { value: 42 } })).statusCode, 200)
    assert.equal(legacyWrites, 1); h.unsupported(); assert.equal((await h.confirm()).statusCode, 503); assert.equal(legacyWrites, 1, 'candidate does not fall back to the legacy route')
  })
  console.log(`GUARDED WRITE MODEL OK: ${cases} memory/Fastify.inject/mock-sink scenarios; confirmation, TCP/RTU queue/connect/send gates, ABA, runtime/reopen, expiry, duplicate, unknown outcome and legacy compatibility. Known gaps remain; no production guard or real driver/socket proof.`)
} finally { net.Server.prototype.listen = saved.listen; net.Socket.prototype.connect = saved.connect; globalThis.fetch = saved.fetch }
