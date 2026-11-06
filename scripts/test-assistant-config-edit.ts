import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerAssistant } from '../packages/api/src/assistant.ts'

const dir = mkdtempSync(join(tmpdir(), 'probe-assistant-cas-')), parent = resolve(tmpdir())
let notify: (() => void) | undefined, failLog = false, proposals = 0
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => notify?.())
const device = cfg.createObject('synthetic assistant', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic group', 3, 0, 2), point = cfg.createRegister(group.id, device.id, null, 3, 0, 'uint16')
const rawPoint = cfg.updateRegister.bind(cfg), rawDevice = cfg.updateObject.bind(cfg), rawGroup = cfg.updateGroup.bind(cfg), rawLog = cfg.log.bind(cfg)
cfg.updateRegister = cfg.updateObject = cfg.updateGroup = (() => { throw new Error('legacy writes forbidden') }) as any
cfg.log = ((...args: Parameters<typeof rawLog>) => { if (failLog) throw new Error('synthetic log failure'); return rawLog(...args) })
let responses: any[] = []
const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: responses.shift() ?? { content: '仅提案，等待人工确认' } }] }))
let app = Fastify()
const register = () => registerAssistant(app, { cfg, store: {}, poller: {} }, dir, fakeFetch)
register()
const request = (method: any, url: string, payload?: unknown) => app.inject({ method, url: '/api/ai' + url, headers: { 'x-probestation-ai': '1' }, ...(payload === undefined ? {} : { payload }) })
let sessionId = ''
const route = (id: string) => `/sessions/${sessionId}/proposals/${id}`
async function propose(target: string, id: number, field: string, value: unknown) {
  responses = [{ tool_calls: [{ id: 'mock-' + ++proposals, type: 'function', function: { name: 'propose_config_change', arguments: JSON.stringify({ target, target_id: id, field, value }) } }] }, { content: '请核对提案' }]
  assert.equal((await request('POST', `/sessions/${sessionId}/messages`, { message: 'synthetic edit' })).statusCode, 200)
  for (let i = 0; i < 200; i++) {
    const result = (await request('GET', '/sessions/' + sessionId)).json()
    if (!result.running) {
      assert(!result.error, result.error); const proposal = result.proposals.at(-1)
      assert(proposal, JSON.stringify(result.entries)); assert.equal(proposal.state, 'pending')
      assert(!('guard' in proposal) && !('undoGuard' in proposal), 'internal conditions are not exposed to UI/model')
      assert(!result.entries.some((entry: any) => entry.role === 'tool' && /"guard"|"undoGuard"/.test(entry.content)))
      return proposal
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('mock assistant timeout')
}
async function restart() { await app.close(); app = Fastify(); register() }
try {
  await request('POST', '/settings', { baseUrl: 'https://mock.invalid/v1', model: 'synthetic' })
  sessionId = (await request('POST', '/sessions', { deviceId: device.id })).json().id
  let p = await propose('register', point.id, 'alias', 'guarded alias')
  const file = () => join(dir, 'ai-sessions', sessionId + '.json')
  assert(JSON.parse(readFileSync(file(), 'utf8')).proposals.at(-1).guard)
  await restart()
  let result = await request('POST', route(p.id), { accept: true })
  assert.equal(result.statusCode, 200, result.body); assert.equal(cfg.getRegister(point.id)!.alias, 'guarded alias')
  assert(!('undoGuard' in result.json().proposals.at(-1)))
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409)
  await restart(); assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 200)
  assert.equal(cfg.getRegister(point.id)!.alias, null, 'undo restores originally NULL alias')
  assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 409)

  // A proposal's label/before must come from the same reviewed row, not an earlier lookup.
  const getPoint = cfg.getRegister.bind(cfg); let firstRead = true
  cfg.getRegister = id => { const row = getPoint(id); if (firstRead) { firstRead = false; rawPoint(id, { alias: 'captured identity' }) }; return row }
  p = await propose('register', point.id, 'alias', 'proposed identity')
  cfg.getRegister = getPoint
  assert.equal(p.before, 'captured identity'); assert.match(p.label, /captured identity/)
  assert.equal((await request('POST', route(p.id), { accept: false })).statusCode, 200)
  rawPoint(point.id, { alias: null })

  p = await propose('register', point.id, 'factor', 2)
  rawPoint(point.id, { unit: 'concurrent unrelated', enumJson: '{"1":"keep"}' })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 200)
  assert.equal(cfg.getRegister(point.id)!.unit, 'concurrent unrelated')
  assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 200)
  assert.equal(cfg.getRegister(point.id)!.factor, 1)

  p = await propose('register', point.id, 'unit', 'new unit')
  rawGroup(group.id, { slaveId: 7 })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409)
  assert.equal(cfg.getRegister(point.id)!.unit, 'concurrent unrelated')
  p = await propose('device', device.id, 'name', 'new name'); rawDevice(device.id, { ip: 'changed.mock.invalid' })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409); assert.equal(cfg.getObject(device.id)!.name, 'synthetic assistant')
  p = await propose('group', group.id, 'name', 'new group'); cfg.createRule(point.id, '>', 2, 'concurrent')
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409); assert.equal(cfg.getGroup(group.id)!.name, 'synthetic group')

  // Inject changes after the route's old single-field comparison but before the conditional transaction.
  const guardedPoint = cfg.updateRegisterSettings.bind(cfg)
  p = await propose('register', point.id, 'alias', 'must reject race')
  cfg.updateRegisterSettings = ((id: number, body: unknown) => { rawPoint(id, { alias: 'race winner' }); return guardedPoint(id, body) })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409)
  cfg.updateRegisterSettings = guardedPoint; assert.equal(cfg.getRegister(point.id)!.alias, 'race winner')
  const guardedGroup = cfg.updateGroupSettings.bind(cfg)
  p = await propose('group', group.id, 'isActive', 0)
  cfg.updateGroupSettings = ((id: number, body: unknown) => { cfg.createRegister(id, device.id, 'race child', 3, 1, 'uint16'); return guardedGroup(id, body) })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409)
  cfg.updateGroupSettings = guardedGroup; assert.equal(cfg.getGroup(group.id)!.isActive, 1)
  const guardedDevice = cfg.updateObjectSettings.bind(cfg)
  p = await propose('device', device.id, 'pollIntervalMs', 1234)
  cfg.updateObjectSettings = ((id: number, body: unknown) => { rawDevice(id, { timeoutMs: 4321 }); return guardedDevice(id, body) })
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409)
  cfg.updateObjectSettings = guardedDevice; assert.notEqual(cfg.getObject(device.id)!.pollIntervalMs, 1234)

  p = await propose('group', group.id, 'name', 'saved group')
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 200)
  rawPoint(point.id, { alias: 'changed child' })
  assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 409); assert.equal(cfg.getGroup(group.id)!.name, 'saved group')
  p = await propose('device', device.id, 'timeoutMs', 2345)
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 200)
  rawDevice(device.id, { ip: 'later.mock.invalid' })
  assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 409); assert.equal(cfg.getObject(device.id)!.timeoutMs, 2345)

  // Return the commit's snapshot; notification changes must not be silently included in the undo guard.
  p = await propose('register', point.id, 'alias', 'committed once')
  notify = () => { notify = undefined; rawGroup(group.id, { slaveId: 8 }); throw new Error('notification failed after later edit') }; failLog = true
  result = await request('POST', route(p.id), { accept: true }); failLog = false
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().proposals.at(-1).state, 'applied'); assert.equal(result.json().proposals.at(-1).warnings.length, 2)
  assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 409)
  assert.equal(cfg.getRegister(point.id)!.alias, 'committed once')

  // Existing semantic values remain valid undo targets, even when the proposal tool would not create them.
  rawPoint(point.id, { factor: 0, unit: '' })
  for (const [field, value, original] of [['factor', 3, 0], ['unit', 'V', '']] as const) {
    p = await propose('register', point.id, field, value)
    assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 200)
    assert.equal((await request('POST', route(p.id) + '/undo', {})).statusCode, 200)
    assert.equal((cfg.getRegister(point.id) as any)[field], original)
  }

  p = await propose('register', point.id, 'alias', 'old session must not execute')
  await app.close(); let saved = JSON.parse(readFileSync(file(), 'utf8')); delete saved.proposals.at(-1).guard; writeFileSync(file(), JSON.stringify(saved)); app = Fastify(); register()
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 409); assert.equal(cfg.getRegister(point.id)!.alias, 'committed once')
  p = await propose('register', point.id, 'alias', 'no persisted consumption')
  // A directory at the temporary filename reliably simulates a disk write failure on all platforms.
  mkdirSync(file() + '.tmp')
  assert.equal((await request('POST', route(p.id), { accept: true })).statusCode, 500)
  assert.equal(cfg.getRegister(point.id)!.alias, 'committed once')
  console.log('ASSISTANT CONFIG EDIT OK: real memory ConfigStore + injected routes/mock model, persisted original/undo guards, no legacy writes, all target races/source conflicts, graph changes, restart/replay/old-session rejection, NULL/zero/empty undo, postcommit warnings and failed consumption persistence; no listeners or external requests')
} finally {
  await app.close(); (cfg as any).db.close()
  assert.equal(dirname(resolve(dir)), parent); assert(basename(dir).startsWith('probe-assistant-cas-')); rmSync(dir, { recursive: true, force: true })
}
