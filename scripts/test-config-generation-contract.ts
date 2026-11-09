/** Transaction contract in synthetic tables only. Not a ConfigStore migration or production write guard. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { ConfigStore } from '../packages/config/src/index.ts'

const maximum = Number.MAX_SAFE_INTEGER
const sourceDDL = 'CREATE TABLE candidate_sources(id INTEGER PRIMARY KEY, slave_id INTEGER NOT NULL); INSERT INTO candidate_sources VALUES(1,7)'
const triggers = ['INSERT', 'UPDATE', 'DELETE'].map(event => `CREATE TRIGGER candidate_${event.toLowerCase()} AFTER ${event} ON candidate_sources BEGIN UPDATE candidate_generation SET version=version+1 WHERE singleton=1; END`)
type Metadata = { install_scope: string; version: number }
function metadata(db: DatabaseSync): Metadata {
  const row = db.prepare('SELECT install_scope, version FROM candidate_generation WHERE singleton=1').get()
  if (!row || typeof row.install_scope !== 'string' || !row.install_scope || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 0 || row.version >= maximum) throw Error('generation unavailable')
  return { install_scope: row.install_scope, version: row.version }
}
/** Test fixture DDL only: rollback must preserve the old synthetic database. */
function installFixture(db: DatabaseSync, failAfter = 0) {
  if (db.isTransaction) throw Error('caller owns transaction')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_generation'").get()) { metadata(db); return }
  const statements = [
    `CREATE TABLE candidate_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), install_scope TEXT NOT NULL, version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0 AND version<=${maximum}))`,
    ...triggers,
  ]
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(statements[0]); if (failAfter === 1) throw Error('synthetic DDL fault')
    db.prepare('INSERT INTO candidate_generation VALUES(1,?,0)').run(randomUUID()); if (failAfter === 2) throw Error('synthetic DDL fault')
    for (let i = 1; i < statements.length; i++) { db.exec(statements[i]); if (failAfter === i + 2) throw Error('synthetic DDL fault') }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
/** Process-local observation contract, deliberately not exported or usable as a wire token. */
function observer(db: DatabaseSync) {
  let lifecycle = Symbol('fixture lifecycle')
  const issued = new WeakMap<object, Metadata & { lifecycle: symbol }>()
  return {
    capture() {
      if (db.isTransaction) throw Error('cannot publish an uncommitted generation')
      db.exec('BEGIN')
      let snapshot: Metadata, slaveId: number
      try { snapshot = metadata(db); slaveId = Number(db.prepare('SELECT slave_id FROM candidate_sources WHERE id=1').get()!.slave_id); db.exec('COMMIT') }
      catch (error) { db.exec('ROLLBACK'); throw error }
      const ticket = Object.freeze({ slaveId }); issued.set(ticket, { ...snapshot, lifecycle }); return ticket
    },
    matches(ticket: object) {
      try {
        if (db.isTransaction) return false
        const expected = issued.get(ticket), current = metadata(db)
        return !!expected && expected.lifecycle === lifecycle && expected.install_scope === current.install_scope && expected.version === current.version
      } catch { return false }
    },
    invalidate() { lifecycle = Symbol('fixture lifecycle') },
  }
}
let cases = 0
async function check(name: string, action: () => void | Promise<void>) { await action(); cases++; console.log('CONFIG GENERATION OK: ' + name) }
function fixture(run: (db: DatabaseSync, reader: ReturnType<typeof observer>) => void, install = true) {
  const db = new DatabaseSync(':memory:')
  try { db.exec(sourceDDL); if (install) installFixture(db); run(db, observer(db)) } finally { db.close() }
}
await check('unsupported old schema stays usable but cannot issue a generation ticket', () => fixture((db, reader) => {
  assert.throws(() => reader.capture()); db.exec('UPDATE candidate_sources SET slave_id=9'); assert.equal(db.prepare('SELECT slave_id FROM candidate_sources').get()!.slave_id, 9)
}, false))
await check('committed ABA changes version even when source values return to A', () => fixture((db, reader) => {
  const before = reader.capture(); db.exec('BEGIN IMMEDIATE; UPDATE candidate_sources SET slave_id=9; UPDATE candidate_sources SET slave_id=7; COMMIT')
  assert.equal(reader.capture().slaveId, before.slaveId); assert.equal(metadata(db).version, 2); assert.equal(reader.matches(before), false)
}))
await check('rollback restores source and committed version and publishes no intermediate ticket', () => fixture((db, reader) => {
  const before = reader.capture(); db.exec('BEGIN IMMEDIATE; UPDATE candidate_sources SET slave_id=9')
  assert.throws(() => reader.capture(), /uncommitted/); assert.equal(reader.matches(before), false)
  db.exec('ROLLBACK'); assert.equal(metadata(db).version, 0); assert.equal(reader.capture().slaveId, 7); assert(reader.matches(before))
}))
await check('SQL failure rolls back all prior changes and trigger increments', () => fixture((db, reader) => {
  const before = reader.capture(); db.exec('BEGIN IMMEDIATE; UPDATE candidate_sources SET slave_id=9')
  assert.throws(() => db.exec('INSERT INTO candidate_sources VALUES(1,11)')); db.exec('ROLLBACK')
  assert.equal(metadata(db).version, 0); assert(reader.matches(before)); assert.equal(reader.capture().slaveId, 7)
}))
await check('actual deferred-constraint COMMIT failure publishes no generation before rollback', () => fixture((db, reader) => {
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE candidate_parent(id INTEGER PRIMARY KEY); CREATE TABLE candidate_child(id INTEGER REFERENCES candidate_parent(id) DEFERRABLE INITIALLY DEFERRED)')
  const before = reader.capture(); db.exec('BEGIN; UPDATE candidate_sources SET slave_id=9; INSERT INTO candidate_child VALUES(99)')
  assert.throws(() => db.exec('COMMIT')); assert.equal(db.isTransaction, true)
  assert.throws(() => reader.capture(), /uncommitted/); assert(!reader.matches(before))
  db.exec('ROLLBACK'); assert.equal(metadata(db).version, 0); assert.equal(reader.capture().slaveId, 7); assert(reader.matches(before))
}))
await check('post-commit notification failure cannot undo a committed generation', () => fixture((db, reader) => {
  const before = reader.capture()
  assert.throws(() => { db.exec('BEGIN; UPDATE candidate_sources SET slave_id=9; COMMIT'); throw Error('synthetic post-commit notification failure') }, /post-commit/)
  assert.equal(db.isTransaction, false); assert.equal(metadata(db).version, 1); assert.equal(reader.capture().slaveId, 9); assert(!reader.matches(before))
}))
await check('nested savepoint rollback retains only the outer committed transition', () => fixture((db, reader) => {
  const before = reader.capture(); db.exec('BEGIN; UPDATE candidate_sources SET slave_id=9; SAVEPOINT inner_scope; UPDATE candidate_sources SET slave_id=11; ROLLBACK TO inner_scope; RELEASE inner_scope; COMMIT')
  assert.equal(metadata(db).version, 1); assert.equal(reader.capture().slaveId, 9); assert(!reader.matches(before))
}))
await check('delete/reinsert of the same ID and value cannot reuse the old generation', () => fixture((db, reader) => {
  const before = reader.capture(); db.exec('BEGIN; DELETE FROM candidate_sources; INSERT INTO candidate_sources VALUES(1,7); COMMIT')
  assert.equal(reader.capture().slaveId, 7); assert.equal(metadata(db).version, 2); assert(!reader.matches(before))
}))
for (const step of [1, 2, 3, 4, 5]) await check('fixture DDL fault ' + step + ' leaves no partial generation schema', () => fixture(db => {
  assert.throws(() => installFixture(db, step), /DDL fault/)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'candidate_%' AND type IN ('table','trigger')").get()!.n, 1)
  assert.equal(db.prepare('SELECT slave_id FROM candidate_sources').get()!.slave_id, 7)
  installFixture(db); assert.equal(metadata(db).version, 0)
}, false))
await check('repeat fixture installation never resets an existing committed generation', () => fixture(db => {
  db.exec('UPDATE candidate_sources SET slave_id=9'); const before = metadata(db); installFixture(db); assert.deepEqual(metadata(db), before)
}))
await check('exhaustion fails closed and rolls back the source mutation without wraparound', () => fixture((db, reader) => {
  const before = reader.capture(); db.prepare('UPDATE candidate_generation SET version=?').run(maximum)
  assert.throws(() => reader.capture(), /unavailable/); assert(!reader.matches(before))
  assert.throws(() => db.exec('UPDATE candidate_sources SET slave_id=9')); assert.equal(db.prepare('SELECT slave_id FROM candidate_sources').get()!.slave_id, 7)
}))
await check('malformed existing metadata is rejected without resetting it', () => fixture(db => {
  db.exec("CREATE TABLE candidate_generation(singleton INTEGER PRIMARY KEY,install_scope TEXT,version TEXT); INSERT INTO candidate_generation VALUES(1,'old','0')")
  assert.throws(() => installFixture(db), /unavailable/); assert.equal(db.prepare('SELECT version FROM candidate_generation').get()!.version, '0')
}, false))
await check('new observer ownership, copied tokens, and connection close fail closed', () => {
  const db = new DatabaseSync(':memory:'); db.exec(sourceDDL); installFixture(db)
  const first = observer(db), ticket = first.capture(); assert(!first.matches({ ...ticket })); assert(!observer(db).matches(ticket))
  db.close(); assert(!first.matches(ticket)); assert.throws(() => first.capture())
})
await check('rebuild and restore require lifecycle invalidation even if counters and content repeat', () => fixture((db, reader) => {
  const before = reader.capture(), saved = metadata(db)
  db.exec('UPDATE candidate_sources SET slave_id=9; UPDATE candidate_sources SET slave_id=7')
  // Models restoring an older database image; administrative metadata writes are not ordinary source mutations.
  db.prepare('UPDATE candidate_generation SET install_scope=?, version=?').run(saved.install_scope, saved.version)
  assert(reader.matches(before), 'negative control: restored metadata alone cannot identify a new lifecycle')
  reader.invalidate(); assert(!reader.matches(before)); assert(reader.matches(reader.capture()))
  console.log('KNOWN GAP: a restored counter/content pair can match without explicit lifecycle invalidation; this fixture is not a production restore guard.')
}))
await check('two temporary connections see committed ABA, rollback, and reopen ownership', () => {
  const root = resolve(tmpdir()), directory = resolve(mkdtempSync(join(root, 'probe-generation-contract-'))), offset = relative(root, directory)
  assert(offset && !offset.startsWith('..') && !resolve(directory).startsWith('\\\\'))
  const file = join(directory, 'synthetic.sqlite'); let a: DatabaseSync | undefined, b: DatabaseSync | undefined
  try {
    a = new DatabaseSync(file); a.exec(sourceDDL); installFixture(a); b = new DatabaseSync(file)
    const reader = observer(a), old = reader.capture(); b.exec('BEGIN IMMEDIATE; UPDATE candidate_sources SET slave_id=9; ROLLBACK')
    assert(reader.matches(old)); b.exec('BEGIN IMMEDIATE; UPDATE candidate_sources SET slave_id=9; UPDATE candidate_sources SET slave_id=7; COMMIT')
    assert(!reader.matches(old)); const current = reader.capture(); assert.equal(current.slaveId, 7)
    a.close(); a = new DatabaseSync(file); assert(!observer(a).matches(current)); assert.equal(metadata(a).version, 2)
  } finally { b?.close(); a?.close(); const checked = relative(root, directory); assert(checked && !checked.startsWith('..') && resolve(directory) !== root); rmSync(directory, { recursive: true, force: true }) }
})
await check('actual current ConfigStore content revision is not a committed generation', async () => {
  const cfg = new ConfigStore({ dbPath: ':memory:' })
  const seed = () => { const d = cfg.createObject('generation mock', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'mock', 3, 0, 1, 'read', 7); cfg.createRegister(g.id, d.id, 'mock', 3, 0, 'uint16'); return g }
  try {
    const g = seed(), before = cfg.getGroupSettings(g.id), scope = cfg.getRecordingIntervalScope()
    cfg.updateGroup(g.id, { slaveId: 9 }); cfg.updateGroup(g.id, { slaveId: 7 })
    assert.equal(cfg.getGroupSettings(g.id).revision, before.revision)
    cfg.reopen(':memory:'); const rebuilt = seed(); assert.equal(cfg.getGroupSettings(rebuilt.id).revision, before.revision); assert.notEqual(cfg.getRecordingIntervalScope(), scope)
    console.log('KNOWN GAP: actual ConfigStore graph hashes repeat on committed ABA and identical rebuild; its lifecycle scope changes on reopen, but no production committed-generation contract was added.')
  } finally { await cfg.close() }
})
console.log(`CONFIG GENERATION CONTRACT OK: ${cases} synthetic SQLite/memory/temp cases; commit/rollback/savepoints/ABA/ID reuse/DDL rollback/reopen/restore/limits. No production schema, migration, write guard or hardware behavior changed.`)
