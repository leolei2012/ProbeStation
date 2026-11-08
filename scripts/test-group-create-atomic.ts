import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import * as client from '../apps/web/src/group-settings-save.ts'
import { stageMemoryConfigurationRecovery } from './fixtures/config-recovery-driver.ts'
let recovery: ReturnType<typeof stageMemoryConfigurationRecovery> | undefined


const app = Fastify(), seen: Array<{ scope: string; id?: number; counts: Array<[number, number]> }> = []
let cfg!: ConfigStore, objectId = 0, armed = false, failNotify = false
cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => {
  if (!armed) return
  seen.push({ scope, id, counts: cfg.listGroups(objectId).map(group => [group.id, cfg.listRegisters(group.id).length]) })
  if (failNotify) throw new Error('synthetic notification failure')
})
const d = cfg.createObject('synthetic atomic create', 'mock.invalid', 502); objectId = d.id
const keep = cfg.createGroup(d.id, 'existing', 3, 0, 1), point = cfg.createRegister(keep.id, d.id, 'keep', 3, 0, 'uint16')
cfg.createRule(point.id, '>', 2, 'keep existing rule'); armed = true
const db = (cfg as any).db, exec = db.exec.bind(db)
const graph = () => JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listGroups(d.id), registers: cfg.listRegistersByObject(d.id), rules: cfg.listRules() })
const source = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let registration: ts.CallExpression | undefined
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/monitor_objects/:id/groups') registration = node; ts.forEachChild(node, visit) }; visit(source)
assert(registration)
new Function('fastify', 'cfg', ts.transpileModule(registration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app, cfg)
const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/monitor_objects/' + d.id + '/groups', payload: body as any })
const body = { name: 'atomic new group', startAddress: 10, quantity: 3, slaveId: 7, isActive: 0 }
try {
  const before = graph()
  exec("CREATE TRIGGER fail_second_default_point BEFORE INSERT ON registers WHEN NEW.start_address = 11 BEGIN SELECT RAISE(ABORT, 'synthetic second point failure'); END")
  const failed = await post(body); assert.equal(failed.statusCode, 500)
  assert.equal(cfg.listGroups(d.id).length, 1, 'a failed default-point INSERT must not leave a newly-created group')
  assert.equal(graph(), before); assert.equal(seen.length, 0, 'failed creation must not announce a partial graph')
  exec('DROP TRIGGER fail_second_default_point')
  const success = await post(body); assert.equal(success.statusCode, 200)
  const created = success.json(); assert(created.id > 0); assert.equal(created.name, body.name); assert.equal(created.isActive, 0); assert.deepEqual(created.warnings, [])
  const points = cfg.listRegisters(created.id); assert.deepEqual(points.map(row => [row.startAddress, row.functionCode, row.dataType]), [[10, 3, 'int16'], [11, 3, 'int16'], [12, 3, 'int16']])
  assert.deepEqual(seen.map(event => event.scope), ['group', 'register', 'register', 'register'], 'retain normal event scopes and order, but publish them after commit')
  assert(seen.every(event => event.counts.find(([id]) => id === created.id)?.[1] === 3), 'even the first notification sees the complete graph')
  assert.deepEqual({ ...cfg.getRegister(point.id)! }, JSON.parse(before).registers[0]); assert.equal(cfg.listRules().length, 1)

  seen.length = 0; failNotify = true
  const warning = await post({ ...body, name: 'committed with notification warning', startAddress: 20, quantity: 2 })
  assert.equal(warning.statusCode, 200); assert.equal(warning.json().warnings.length, 1); assert.match(warning.json().warnings[0], /已创建.*勿重复/)
  assert.equal(cfg.listRegisters(warning.json().id).length, 2); assert.equal(seen.length, 3, 'attempt each original notification once, without retrying the create')
  assert(seen.every(event => event.counts.find(([id]) => id === warning.json().id)?.[1] === 2)); failNotify = false
  const warnings = (client as any).groupCreateWarnings(warning.json()); assert.deepEqual(warnings, warning.json().warnings); assert(Object.isFrozen(warnings))
  assert.deepEqual((client as any).groupCreateWarnings({ id: 1, name: 'legacy response' }), [])
  for (const value of [null, {}, [], { id: 0 }, { id: 1.5 }]) assert.throws(() => (client as any).groupCreateWarnings(value), /待核实.*重复/)
  for (const warnings of [null, 'bad', [1]]) assert.throws(() => (client as any).groupCreateWarnings({ id: 1, warnings }), /待核实.*重复/)
  const ui = readFileSync(new URL('../apps/web/src/GroupModal.tsx', import.meta.url), 'utf8'); assert.match(ui, /onSaved\(groupCreateWarnings\(result\)\)/)

  const committed = graph(); seen.length = 0
  db.exec = (sql: string) => { if (sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql) }
  assert.equal((await post({ ...body, startAddress: 30 })).statusCode, 500); db.exec = exec
  assert.equal(graph(), committed); assert.equal(seen.length, 0)
  assert.equal((await post({ ...body, startAddress: 30 })).statusCode, 200, 'successful rollback permits an explicit later create')

  // BEGIN failure must not roll back a transaction owned by a caller.
  exec('BEGIN'); db.prepare('UPDATE monitor_objects SET name = ? WHERE id = ?').run('outer pending', d.id)
  assert.throws(() => cfg.createGroupWithRegisters(d.id, 'not nested', 3, 40, 1))
  assert.equal(cfg.getObject(d.id)!.name, 'outer pending'); exec('ROLLBACK')
  const normal = graph(); seen.length = 0
  ;(cfg as any).restoring = true
  try { assert.throws(() => cfg.createGroupWithRegisters(d.id, 'not nested', 3, 40, 1), error => (error as any)?.statusCode === 409) }
  finally { (cfg as any).restoring = false }
  assert.equal(graph(), normal)

  let begins = 0
  db.exec = (sql: string) => { if (sql === 'BEGIN IMMEDIATE') begins++; return exec(sql) }
  for (const isActive of [null, true, '0', 2]) assert.equal((await post({ ...body, isActive })).statusCode, 400)
  db.exec = exec; assert.equal(begins, 0); assert.equal(graph(), normal); assert.equal(seen.length, 0)

  // Unknown rollback result is an error, never a success or a configuration event. Cleanup only this memory transaction.
  recovery = stageMemoryConfigurationRecovery(cfg)
  db.exec = (sql: string) => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('synthetic transaction outcome failure'); return exec(sql) }
  assert.throws(() => cfg.createGroupWithRegisters(d.id, 'uncertain', 3, 50, 1), AggregateError)
  assert.equal(seen.length, 0); db.exec = exec; exec('ROLLBACK'); assert.throws(graph, /此连接已隔离/); recovery.reopen(); assert.equal(graph(), normal)
  const primitive = cfg.createGroup(d.id, 'primitive remains independent', 3, 60, 1); assert.equal(cfg.listRegisters(primitive.id).length, 0)
  console.log('GROUP CREATE ATOMIC OK: actual POST with memory/fresh-temporary SQLite trigger/commit failures, complete rollback and explicit retry, no partial notifications, complete postcommit graph with original event order, committed notification warnings/client propagation, nested BEGIN ownership, prewrite flag rejection, unknown rollback and unchanged primitive creation; no service, DOM, network or hardware')
} finally { db.exec = exec; try { exec('ROLLBACK') } catch {} await app.close(); await cfg.close(); await recovery?.close() }
