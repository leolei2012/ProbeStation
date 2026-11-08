import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import ts from 'typescript'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { registerGroupSettings } from '../packages/api/src/group-settings.ts'
import { parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'

assert.deepEqual(process.argv.slice(2), ['--synthetic'], 'Only --synthetic is supported; database/device arguments are forbidden.')
const root = fileURLToPath(new URL('../', import.meta.url)), names = ['deleteObject', 'deleteGroup', 'deleteRegister'] as const
const tick = () => new Promise<void>(done => setImmediate(done))
const denied: string[] = [], unhandled: unknown[] = [], passed: string[] = []
const block = (name: string) => () => { denied.push(name); throw Error('Unexpected real I/O: ' + name) }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const onUnhandled = (error: unknown) => { unhandled.push(error) }
const tables = ['monitor_objects', 'register_groups', 'registers', 'alarm_rules', 'logs']
const graph = (db: DatabaseSync) => JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])))
const calls: { file: string; line: number; method: string; receiver: string; owner: string; direct: boolean }[] = []
const dynamic: string[] = [], bindings: string[] = []
let files = 0
function owner(node: ts.Node, source: ts.SourceFile): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent)) return 'method:' + parent.name.getText(source)
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && ts.isStringLiteral(parent.arguments[0])) {
      const method = parent.expression.name.text
      if (method === 'delete' || method === 'registerTool') return method + ':' + parent.arguments[0].text
    }
  }
  return 'unresolved'
}
function inspect(file: string) {
  files++
  const text = readFileSync(file, 'utf8'), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const path = relative(root, file).replaceAll('\\', '/')
  function visit(node: ts.Node) {
    let name: string | undefined, receiver: string | undefined
    if (ts.isPropertyAccessExpression(node)) { name = node.name.text; receiver = node.expression.getText(source) }
    if (ts.isElementAccessExpression(node)) {
      receiver = node.expression.getText(source)
      if (ts.isStringLiteral(node.argumentExpression)) name = node.argumentExpression.text
      else if (['cfg', 'this.cfg', 'this.ctx.config', 'ctx.config', 'this.config'].includes(receiver)) dynamic.push(path + ':' + node.getStart(source))
    }
    if (name && names.includes(name as typeof names[number])) calls.push({ file: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, method: name, receiver: receiver!, owner: owner(node, source), direct: ts.isCallExpression(node.parent) && node.parent.expression === node })
    if (ts.isBindingElement(node) && names.includes((node.propertyName ?? node.name).getText(source) as typeof names[number])) bindings.push(path + ':' + node.getStart(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
}
function walk(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Audit will not follow source symlinks')
    const file = join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) inspect(file)
  }
}
for (const collection of ['packages', 'apps']) for (const entry of readdirSync(join(root, collection), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const source = join(root, collection, entry.name, 'src')
  if (existsSync(source)) walk(source)
}
const expected = [
  ['packages/api/src/index.ts', 'deleteObject', 'cfg', 'delete:/api/monitor_objects/:id'],
  ['packages/api/src/index.ts', 'deleteGroup', 'cfg', 'delete:/api/groups/:id'],
  ['packages/api/src/index.ts', 'deleteRegister', 'cfg', 'delete:/api/registers/:id'],
  ['packages/mcp/src/index.ts', 'deleteObject', 'cfg', 'registerTool:delete_device'],
  ['packages/mcp/src/index.ts', 'deleteGroup', 'cfg', 'registerTool:delete_group'],
  ['packages/mcp/src/index.ts', 'deleteRegister', 'cfg', 'registerTool:delete_register'],
  ['packages/config/src/index.ts', 'deleteRegister', 'this', 'method:updateGroupRows'],
  ['packages/config/src/index.ts', 'deleteGroup', 'this', 'method:applyPointBookImport'],
].map(value => value.join('|')).sort()
assert.deepEqual(calls.map(call => [call.file, call.method, call.receiver, call.owner].join('|')).sort(), expected)
assert(calls.every(call => call.direct)); assert.deepEqual(dynamic, []); assert.deepEqual(bindings, [])
console.log('DELETE CALLERS STATIC: ' + JSON.stringify({ sourceFiles: files, calls, dynamic, bindings }))
passed.push('static-production-source-inventory')

// Register the real legacy route, not a duplicated request implementation.
const apiFile = join(root, 'packages/api/src/index.ts'), apiSource = ts.createSourceFile(apiFile, readFileSync(apiFile, 'utf8'), ts.ScriptTarget.Latest, true)
let legacy: ts.CallExpression | undefined
function route(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'put' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/groups/:id') { assert.equal(legacy, undefined); legacy = node }
  ts.forEachChild(node, route)
}
route(apiSource); assert(legacy)
const legacyCode = ts.transpileModule(legacy.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
async function scenario(name: string, action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  try { await action(f); passed.push(name); console.log('DELETE CALLERS OK: ' + name) }
  finally { await f.close() }
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'probestation-delete-callers-')), file = join(directory, 'synthetic.sqlite')
  let armed = false, failNotify = false, db!: DatabaseSync, reader!: DatabaseSync
  const events: { scope: string; transaction: boolean; writer: string; reader: string; groups: number; points: number; rules: number }[] = []
  const cfg = new ConfigStore({ dbPath: file }, scope => {
    if (!armed) return
    const points = cfg.listRegistersByObject(target.id), ids = new Set(points.map(row => row.id))
    events.push({ scope, transaction: db.isTransaction, writer: graph(db), reader: graph(reader), groups: cfg.listGroups(target.id).length, points: points.length, rules: cfg.listRules().filter(rule => ids.has(rule.registerId)).length })
    if (failNotify) throw Error('Synthetic post-commit observer failure')
  })
  const target = cfg.createObject('target', 'target.mock.invalid', 502), source = cfg.createObject('source', 'source.mock.invalid', 502)
  const group = cfg.createGroup(target.id, 'target first', 3, 0, 3), sibling = cfg.createGroup(target.id, 'target other', 3, 10, 1), sg = cfg.createGroup(source.id, 'imported group', 3, 100, 2)
  const points = [0, 1, 2].map(address => cfg.createRegister(group.id, target.id, 'target ' + address, 3, address, 'uint16'))
  const all = [...points, cfg.createRegister(sibling.id, target.id, 'other', 3, 10, 'uint16'), ...[100, 101].map(address => cfg.createRegister(sg.id, source.id, 'source ' + address, 3, address, 'uint16'))]
  for (const point of all) cfg.createRule(point.id, '>', 1, 'synthetic rule')
  db = (cfg as unknown as { db: DatabaseSync }).db; db.exec('PRAGMA busy_timeout=0')
  reader = new DatabaseSync(file, { readOnly: true }); reader.exec('PRAGMA busy_timeout=0')
  const entries: { method: string; transaction: boolean; restoring: boolean; reader: string; notifications: number }[] = []
  for (const method of names) {
    const original = cfg[method].bind(cfg)
    cfg[method] = id => { entries.push({ method, transaction: db.isTransaction, restoring: (cfg as unknown as { restoring: boolean }).restoring, reader: graph(reader), notifications: events.length }); return original(id) }
  }
  const api = Fastify(), sink = new Sink({ config: cfg })
  new Function('fastify', 'cfg', legacyCode)(api, cfg); registerGroupSettings(api, cfg)
  const workbook = (await sink.exportPointSheet(source.id)).buffer
  return {
    cfg, db, reader, target, source, group, sibling, points, entries, events, api, sink, workbook,
    arm(notificationFailure = false) { armed = true; failNotify = notificationFailure },
    async close() {
      await api.close(); if (reader.isTransaction) reader.exec('ROLLBACK'); reader.close()
      if (db.isTransaction) db.exec('ROLLBACK'); await cfg.close()
      const resolved = resolve(directory)
      assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase()); assert(basename(resolved).startsWith('probestation-delete-callers-'))
      assert(lstatSync(resolved).isDirectory() && !lstatSync(resolved).isSymbolicLink()); rmSync(resolved, { recursive: true, force: true })
    },
  }
}
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch
process.on('unhandledRejection', onUnhandled)
try {
  for (const surface of ['legacy-rest', 'guarded-rest']) for (const mode of ['success', 'sql-failure', 'notification-failure']) await scenario(surface + '/' + mode, async f => {
    const before = graph(f.db), snapshot = f.cfg.getGroupSettings(f.group.id), changes = { quantity: 1 }
    if (mode === 'sql-failure') f.db.exec(`CREATE TRIGGER synthetic_delete_fail BEFORE DELETE ON registers WHEN OLD.id=${f.points[2].id} BEGIN SELECT RAISE(ABORT,'synthetic second delete'); END`)
    const plan = planGroupResize(snapshot, parseGroupEditChanges(changes, snapshot.group))
    f.arm(mode === 'notification-failure')
    const response = await f.api.inject({ method: 'PUT', url: '/api/groups/' + f.group.id + (surface === 'guarded-rest' ? '/settings' : ''), payload: surface === 'legacy-rest' ? changes : { expectedRevision: snapshot.revision, changes, confirmedDeletion: { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } } })
    assert.equal(f.entries.length, 2)
    assert(f.entries.every(entry => entry.method === 'deleteRegister' && entry.transaction && entry.restoring && entry.reader === before && entry.notifications === 0))
    assert.equal(f.db.isTransaction, false); assert.equal((f.cfg as unknown as { restoring: boolean }).restoring, false)
    if (mode === 'sql-failure') { assert.equal(response.statusCode, 500); assert.equal(graph(f.db), before); assert.equal(graph(f.reader), before); assert.equal(f.events.length, 0) }
    else {
      assert.equal(response.statusCode, mode === 'notification-failure' && surface === 'legacy-rest' ? 500 : 200)
      if (mode === 'notification-failure' && surface === 'guarded-rest') assert.equal(response.json().warnings.length, 1)
      assert.equal(f.events.length, 1); const event = f.events[0]
      assert.deepEqual([event.scope, event.transaction, event.groups, event.points, event.rules], ['group', false, 2, 2, 2])
      assert.equal(event.writer, event.reader); assert.equal(event.reader, graph(f.db))
    }
  })
  for (const mode of ['success', 'sql-failure', 'notification-failure', 'append-control']) await scenario('actual-sink/' + mode, async f => {
    const before = graph(f.db)
    if (mode === 'sql-failure') f.db.exec(`CREATE TRIGGER synthetic_group_fail BEFORE DELETE ON register_groups WHEN OLD.id=${f.sibling.id} BEGIN SELECT RAISE(ABORT,'synthetic second group delete'); END`)
    f.arm(mode === 'notification-failure')
    let result: Awaited<ReturnType<Sink['importPointBook']>> | undefined, error: unknown
    try { result = await f.sink.importPointBook(f.target.id, f.workbook, mode !== 'append-control') } catch (failure) { error = failure }
    assert.equal(f.entries.length, mode === 'append-control' ? 0 : 2)
    assert(f.entries.every(entry => entry.method === 'deleteGroup' && entry.transaction && entry.restoring && entry.reader === before && entry.notifications === 0))
    assert.equal(f.db.isTransaction, false); assert.equal((f.cfg as unknown as { restoring: boolean }).restoring, false)
    if (mode === 'sql-failure') { assert(error); assert.equal(graph(f.db), before); assert.equal(graph(f.reader), before); assert.equal(f.events.length, 0) }
    else {
      assert.equal(error, undefined); assert(result); assert.equal(result.errors.length, 0); assert.equal(result.warnings.length, mode === 'notification-failure' ? 1 : 0)
      assert.equal(f.events.length, 1); const event = f.events[0]
      assert.deepEqual([event.scope, event.transaction, event.groups, event.points, event.rules], ['point-book-import', false, mode === 'append-control' ? 3 : 1, mode === 'append-control' ? 6 : 2, mode === 'append-control' ? 6 : 2])
      assert.equal(event.writer, event.reader, 'the completed metadata graph is already visible on the other connection before notification')
    }
  })
  await tick(); assert.deepEqual(denied, []); assert.deepEqual(unhandled, []); assert.equal(passed.length, 11)
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', onUnhandled) }
console.log('DELETE CALLERS AUDIT COMPLETE: 8 static call sites and 11 inventory/real-route/two-connection/Sink cases; managed caller transactions suppress intermediate deletion notifications; no production fix, real data, network listeners or devices')
