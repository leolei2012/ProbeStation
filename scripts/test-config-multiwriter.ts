/** Temporary real ConfigStore schema + independent SQLite process. No production migration/send gate. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ConfigStore } from '../packages/config/src/index.ts'

if (process.argv.length !== 2) throw Error('No database paths or other arguments accepted')
const tables = ['monitor_objects', 'register_groups', 'registers'] as const
const ddl = ["CREATE TABLE candidate_multiwriter(singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL, version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0))",
  ...tables.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(event => `CREATE TRIGGER candidate_mw_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE candidate_multiwriter SET version=version+1 WHERE singleton=1; END`))]
function verify(db: DatabaseSync) {
  for (const sql of ddl) { const name = /CREATE (?:TABLE|TRIGGER) (\w+)/.exec(sql)![1]; assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql, sql, 'missing/changed candidate schema') }
  const statement = db.prepare('SELECT scope,version FROM candidate_multiwriter WHERE singleton=1'); statement.setReadBigInts(true)
  const row = statement.get()
  assert(row && typeof row.scope === 'string' && row.scope && typeof row.version === 'bigint' && row.version >= 0n && row.version < 9223372036854775807n)
  return { scope: row.scope, version: row.version }
}
function install(db: DatabaseSync, failAt = -1) {
  if (db.isTransaction) throw Error('caller transaction unsupported')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_multiwriter'").get()) { verify(db); return }
  db.exec('BEGIN IMMEDIATE')
  try { ddl.forEach((sql, i) => { db.exec(sql); if (i === failAt) throw Error('injected migration failure') }); db.prepare('INSERT INTO candidate_multiwriter VALUES(1,?,0)').run(randomUUID()); db.exec('COMMIT') }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
// Child accepts only this fixture's generated path and fixed SQL via argument vector, never a shell.
function other(file: string, sql: string) {
  const source = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);try{db.exec(process.argv[2]);process.stdout.write('committed')}catch(e){process.stdout.write('refused');process.exitCode=2}finally{db.close()}`
  const result = spawnSync(process.execPath, ['-e', source, file, sql], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert(!result.error, String(result.error)); assert([0, 2].includes(result.status!)); return result.status === 0
}
type Ticket = ReturnType<typeof verify>
function same(a: Ticket, b: Ticket) { return a.scope === b.scope && a.version === b.version }
function capture(db: DatabaseSync) { db.exec('BEGIN'); try { const ticket = verify(db); db.prepare('SELECT * FROM registers WHERE id=1').get(); db.exec('COMMIT'); return ticket } catch (error) { db.exec('ROLLBACK'); throw error } }
// Synchronous mock emission only, no SDK call/await/production capability. Not safe for arbitrary callbacks.
function guardedMock(db: DatabaseSync, ticket: Ticket, emit: () => void) {
  if (db.isTransaction) return false
  db.exec('BEGIN IMMEDIATE')
  try { if (!same(ticket, verify(db))) return false; emit(); return true }
  catch { return false }
  finally { db.exec('ROLLBACK') }
}
let passed = 0
async function fixture(name: string, run: (db: DatabaseSync, cfg: ConfigStore, file: string) => void | Promise<void>, migrated = true) {
  const base = resolve(tmpdir()), dir = mkdtempSync(join(base, 'probestation-multiwriter-')), file = join(dir, 'synthetic.sqlite')
  const cfg = new ConfigStore({ dbPath: file }); let db: DatabaseSync | undefined
  try {
    const object = cfg.createObject('synthetic', 'mock.invalid', 502), group = cfg.createGroup(object.id, 'synthetic', 3, 0, 2, 'read', 7)
    cfg.createRegister(group.id, object.id, 'synthetic', 3, 0, 'uint16'); db = new DatabaseSync(file); if (migrated) install(db)
    await run(db, cfg, file); passed++; console.log('CONFIG MULTIWRITER OK: ' + name)
  } finally { db?.close(); await cfg.close(); const inside = relative(base, resolve(dir)); assert(inside && !inside.startsWith('..') && !inside.includes('\\') && !inside.includes('/')); assert(inside.startsWith('probestation-multiwriter-')); rmSync(dir, { recursive: true }) }
}
await fixture('old database unchanged without explicit fixture install; cannot capture', (db, cfg) => { assert.throws(() => capture(db)); cfg.updateObject(1, { name: 'still usable' }); assert.equal(cfg.getObject(1)!.name, 'still usable') }, false)
await fixture('explicit fixture migration atomic at every DDL boundary', db => {
  for (let index = 0; index < ddl.length; index++) { assert.throws(() => install(db, index)); assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'candidate_m%' OR name LIKE 'candidate_mw_%'").get()!.n, 0); assert.equal(db.prepare('SELECT count(*) n FROM registers').get()!.n, 1) }
  install(db); const original = capture(db); install(db); assert(same(original, capture(db)))
}, false)
await fixture('all three source tables advance for raw cross-process DML, including ABA', (db, _cfg, file) => {
  for (const [table, field, a, b] of [['monitor_objects', 'port', 502, 503], ['register_groups', 'slave_id', 7, 9], ['registers', 'start_address', 0, 1]] as const) {
    const original = capture(db); assert(other(file, `BEGIN IMMEDIATE;UPDATE ${table} SET ${field}=${b} WHERE id=1;UPDATE ${table} SET ${field}=${a} WHERE id=1;COMMIT`)); assert(!same(original, capture(db)))
  }
})
await fixture('actual ConfigStore edits and insertion/deletion invalidate, logs do not', (db, cfg) => {
  let before = capture(db); cfg.updateObject(1, { name: 'renamed' }); assert(!same(before, capture(db))); before = capture(db)
  cfg.log('INFO', 'synthetic', 'not a source edit'); assert(same(before, capture(db)))
  const point = cfg.createRegister(1, 1, 'new', 3, 1); assert(!same(before, capture(db))); before = capture(db); cfg.deleteRegister(point.id); assert(!same(before, capture(db)))
})
await fixture('cross-process rollback leaves committed generation unchanged', (db, _cfg, file) => { const before = capture(db); assert(other(file, 'BEGIN IMMEDIATE;UPDATE register_groups SET slave_id=9;ROLLBACK')); assert(same(before, capture(db))) })
await fixture('savepoint rollback does not publish an intermediate committed identity', db => { const before = capture(db); db.exec('BEGIN;SAVEPOINT x;UPDATE register_groups SET slave_id=9;ROLLBACK TO x;RELEASE x;COMMIT'); assert(same(before, capture(db))) })
await fixture('process-independent identity survives new read connection', (db, _cfg, file) => { const expected = capture(db), reader = new DatabaseSync(file); try { assert(same(expected, capture(reader))) } finally { reader.close() } })
await fixture('existing ConfigStore opens the candidate schema and preserves zero-factor edits', async (db, _cfg, file) => {
  const before = capture(db), writer = new ConfigStore({ dbPath: file })
  try { writer.updateRegister(1, { factor: 0 }); assert.equal(writer.getRegister(1)!.factor, 0); assert(!same(before, capture(db))) } finally { await writer.close() }
})
await fixture('stale queued ticket refuses before mock emission after external commit', (db, _cfg, file) => { const expected = capture(db); let frames = 0; assert(other(file, 'UPDATE register_groups SET slave_id=9')); assert.equal(guardedMock(db, expected, () => { frames++ }), false); assert.equal(frames, 0) })
await fixture('write reservation blocks other process until synchronous mock emission ends', (db, _cfg, file) => {
  const expected = capture(db); let frames = 0
  assert(guardedMock(db, expected, () => { assert.equal(other(file, 'UPDATE register_groups SET slave_id=9'), false); frames++ })); assert.equal(frames, 1)
  assert(other(file, 'UPDATE register_groups SET slave_id=9')); assert(!same(expected, capture(db)))
})
await fixture('reservation released before SDK-style queue emission is unsafe', (db, _cfg, file) => {
  const expected = capture(db); const queued: Array<() => void> = []; let frames = 0
  assert(guardedMock(db, expected, () => queued.push(() => { frames++ })))
  assert(other(file, 'UPDATE register_groups SET slave_id=9')); queued[0](); assert.equal(frames, 1, 'counterexample, not a protection pass'); assert(!same(expected, capture(db)))
})
await fixture('same-connection reentry bypasses SQLite cross-process lock: exclusive owner still required', db => {
  const expected = capture(db); let frames = 0
  assert(guardedMock(db, expected, () => { db.exec('UPDATE register_groups SET slave_id=9'); frames++ })); assert.equal(frames, 1, 'counterexample: a lock is not a same-connection mutex')
})
await fixture('missing trigger/metadata fail closed; unsupported schema is not auto repaired', db => {
  const expected = capture(db); db.exec('DROP TRIGGER candidate_mw_registers_UPDATE'); let frames = 0
  assert.throws(() => install(db)); assert.equal(guardedMock(db, expected, () => { frames++ }), false); assert.equal(frames, 0)
})
await fixture('signed integer exhaustion rejects update without silently floating version', db => {
  db.exec('UPDATE candidate_multiwriter SET version=9223372036854775807'); assert.throws(() => capture(db)); assert.throws(() => db.exec('UPDATE register_groups SET slave_id=9')); assert.equal(db.prepare('SELECT slave_id FROM register_groups').get()!.slave_id, 7)
})
console.log(`CONFIG MULTIWRITER TEST OK: ${passed} temporary-schema/cross-process/mock-send groups; queue and reentry counterexamples remain unprotected. No production migration, API or hardware change.`)
