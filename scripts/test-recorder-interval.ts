import assert from 'node:assert/strict'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

// Regression: an edit arrives after finish reads the recording rate but before its old unconditional write.
const cfg = new ConfigStore({ dbPath: ':memory:' })
const device = cfg.createObject('synthetic recording', 'mock.invalid', 502)
const read = cfg.getObject.bind(cfg), update = cfg.updateObject.bind(cfg)
let interrupt = false
cfg.getObject = id => {
  const row = read(id)
  if (interrupt) { interrupt = false; update(id, { pollIntervalMs: 750 }) }
  return row
}
const recorder = new Recorder({ on() {} }, cfg)
try {
  const id = recorder.startRecording(device.id, 10, 60000)
  interrupt = true; recorder.stopRecording(id)
  assert.equal(read(device.id)!.pollIntervalMs, 750, 'finishing must not overwrite a user edit between compare and restore')
  console.log('RECORDER INTERVAL OK: interleaved user edit preserved (memory-only)')
} finally { for (const session of recorder.listRecordings()) recorder.stopRecording(session.id); (cfg as any).db.close() }

const timers = new Map<number, () => void>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout
let nextTimer = 0
globalThis.setTimeout = ((fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }) as any
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as any
function scenario(run: (cfg: ConfigStore, recorder: Recorder, id: number, events: () => number, failNotify: () => void) => void) {
  let events = 0, fail = false
  const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { events++; if (fail) throw new Error('synthetic notification failure') })
  const device = cfg.createObject('synthetic interval', 'mock.invalid', 502)
  const recorder = new Recorder({ on() {} }, cfg)
  try { run(cfg, recorder, device.id, () => events, () => { fail = true }) }
  finally { for (const session of recorder.listRecordings()) recorder.stopRecording(session.id); (cfg as any).db.close(); assert.equal(timers.size, 0, 'every completed/failed session releases its timer') }
}
const start = (recorder: Recorder, id: number) => recorder.startRecording(id, 10, 60000)
try {
  scenario((cfg, recorder, id, events) => {
    const n = events(), a = start(recorder, id), b = start(recorder, id)
    cfg.log('INFO', 'synthetic', 'same connection logging must not revoke interval ownership')
    const other = cfg.createObject('other', 'other.mock.invalid', 502); cfg.updateObject(other.id, { pollIntervalMs: 77 })
    const beforeStop = events(); recorder.stopRecording(a)
    assert.equal(recorder.getRecording(a)!.intervalRestore, 'shared'); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10); assert.equal(events(), beforeStop)
    recorder.stopRecording(b); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000); assert.equal(recorder.getRecording(b)!.intervalRestore, 'restored'); assert.equal(events(), beforeStop + 1)
    recorder.stopRecording(b); recorder.deleteRecording(a); assert.equal(events(), beforeStop + 1); assert(events() > n)
  })
  for (const edits of [[10], [55], [55, 10]]) scenario((cfg, recorder, id) => {
    const session = start(recorder, id)
    for (const interval of edits) cfg.updateObject(id, { pollIntervalMs: interval }) // Including legacy REST's same-value intent.
    assert.throws(() => start(recorder, id), /interval|ownership|changed/i)
    recorder.stopRecording(session); assert.equal(cfg.getObject(id)!.pollIntervalMs, edits.at(-1)); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved')
    assert(recorder.getRecording(session)!.warnings.length); recorder.stopRecording(session); assert.equal(cfg.getObject(id)!.pollIntervalMs, edits.at(-1))
  })
  scenario((cfg, recorder, id) => {
    const session = start(recorder, id); cfg.updateObject(id, { ip: 'new.mock.invalid' }); recorder.stopRecording(session)
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved')
  })
  scenario((cfg, recorder, id) => {
    const read = cfg.getObject.bind(cfg), update = cfg.updateObject.bind(cfg); let first = true
    cfg.getObject = id => { const row = read(id); if (first) { first = false; update(id, { pollIntervalMs: 750 }) }; return row }
    const session = start(recorder, id)
    assert.equal(recorder.getRecording(session)!.originalPollInterval, 750, 'acquisition captures the actual original under its write lock')
    recorder.stopRecording(session); assert.equal(read(id)!.pollIntervalMs, 750)
  })
  scenario((cfg, recorder, id, _events, failNotify) => {
    failNotify(); const session = start(recorder, id)
    assert.equal(recorder.getRecording(session)!.warnings.length, 1); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10)
    timers.get(nextTimer)!(); assert.equal(recorder.getRecording(session)!.intervalRestore, 'restored'); assert.equal(recorder.getRecording(session)!.warnings.length, 2); assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000)
  })
  scenario((cfg, recorder, id) => {
    const session = start(recorder, id); let attempts = 0
    cfg.restoreRecordingInterval = (() => { attempts++; throw new Error('synthetic private detail') }) as any
    assert.doesNotThrow(() => timers.get(nextTimer)!()); assert.equal(recorder.getRecording(session)!.status, 'done'); assert.equal(recorder.getRecording(session)!.intervalRestore, 'uncertain')
    assert(!recorder.getRecording(session)!.warnings.join().includes('private detail')); recorder.stopRecording(session); recorder.deleteRecording(session); assert.equal(attempts, 1)
  })
  scenario((cfg, recorder, id) => {
    const db = (cfg as any).db, prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => { if (sql.startsWith('UPDATE monitor_objects SET poll_interval_ms')) throw new Error('synthetic acquisition write failure'); return prepare(sql) }
    assert.throws(() => start(recorder, id), /synthetic acquisition/); db.prepare = prepare
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 1000); assert.equal(recorder.listRecordings().length, 0)
    const session = start(recorder, id), exec = db.exec.bind(db); let once = true
    db.exec = (sql: string) => { if (once && sql === 'COMMIT') { once = false; throw new Error('synthetic restore commit failure') }; return exec(sql) }
    recorder.stopRecording(session); db.exec = exec
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 10, 'failed restore transaction rolls back'); assert.equal(recorder.getRecording(session)!.intervalRestore, 'uncertain')
  })
  scenario((cfg, recorder, id) => {
    const session = start(recorder, id), db = (cfg as any).db
    db.exec("CREATE TRIGGER synthetic_restore AFTER UPDATE OF poll_interval_ms ON monitor_objects WHEN NEW.poll_interval_ms=1000 BEGIN UPDATE monitor_objects SET poll_interval_ms=9 WHERE id=NEW.id; END")
    recorder.stopRecording(session); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(session)!.intervalRestore, 'uncertain')
    db.exec('DROP TRIGGER synthetic_restore')
  })
  scenario((cfg, recorder, id) => {
    const session = start(recorder, id)
    cfg.reopen(':memory:'); const replacement = cfg.createObject('synthetic interval', 'mock.invalid', 502, 'master', { pollIntervalMs: 10 })
    assert.equal(replacement.id, id); recorder.stopRecording(session); assert.equal(cfg.getObject(id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved')
  })
  scenario((cfg, _recorder, id, events) => {
    const n = events(), row = JSON.stringify(cfg.getObject(id))
    for (const rate of [0, -1, 1.5, Infinity, 2147483648, '10', null]) assert.throws(() => cfg.acquireRecordingInterval(id, rate as any), error => (error as any).statusCode === 400)
    assert.equal(JSON.stringify(cfg.getObject(id)), row); assert.equal(events(), n)
    const { lease } = cfg.acquireRecordingInterval(id, 10)
    assert.equal(cfg.restoreRecordingInterval({ ...lease }).state, 'preserved', 'serialized/copied leases never confer ownership')
    assert.equal(cfg.getObject(id)!.pollIntervalMs, 10); assert.equal(cfg.restoreRecordingInterval(lease).state, 'restored'); assert.equal(cfg.restoreRecordingInterval(lease).state, 'preserved')
  })
} finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear }

// Two real SQLite connections, confined to a new disposable directory. No user database is opened.
const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'probe-recording-interval-'))
let a: ConfigStore | undefined, b: ConfigStore | undefined, externalRecorder: Recorder | undefined
try {
  const path = join(dir, 'isolated.db'); a = new ConfigStore({ dbPath: path }); b = new ConfigStore({ dbPath: path })
  const d = a.createObject('two connection mock', 'mock.invalid', 502), recorder = new Recorder({ on() {} }, a), db = (a as any).db
  externalRecorder = recorder
  const schema = () => JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all())
  const beforeSchema = schema()
  let session = start(recorder, d.id)
  b.updateObject(d.id, { pollIntervalMs: 55 }); b.updateObject(d.id, { pollIntervalMs: 10 })
  recorder.stopRecording(session); assert.equal(a.getObject(d.id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved', 'external ABA invalidates through SQLite data_version')
  a.updateObject(d.id, { pollIntervalMs: 1000 }); session = start(recorder, d.id)
  b.log('INFO', 'synthetic', 'a foreign commit of unknown scope conservatively revokes restoration')
  recorder.stopRecording(session); assert.equal(a.getObject(d.id)!.pollIntervalMs, 10); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved')
  a.updateObject(d.id, { pollIntervalMs: 1000 }); session = start(recorder, d.id)
  const prepare = db.prepare.bind(db); let blocked = 0
  db.prepare = (sql: string) => {
    if (sql.startsWith('UPDATE monitor_objects SET poll_interval_ms')) { assert.throws(() => b!.updateObject(d.id, { pollIntervalMs: 750 }), /locked|busy/i); blocked++ }
    return prepare(sql)
  }
  recorder.stopRecording(session); db.prepare = prepare
  assert.equal(blocked, 1); assert.equal(a.getObject(d.id)!.pollIntervalMs, 1000); assert.equal(recorder.getRecording(session)!.intervalRestore, 'restored')
  session = start(recorder, d.id); b.deleteObject(d.id); recorder.stopRecording(session)
  assert.equal(a.getObject(d.id), undefined); assert.equal(recorder.getRecording(session)!.intervalRestore, 'preserved')
  assert.equal(schema(), beforeSchema, 'recording adds no persistent columns/tables/triggers')
} finally {
  for (const session of externalRecorder?.listRecordings() ?? []) externalRecorder!.stopRecording(session.id)
  if (a) (a as any).db.close(); if (b) (b as any).db.close()
  assert.equal(dirname(resolve(dir)), parent); assert(basename(dir).startsWith('probe-recording-interval-')); rmSync(dir, { recursive: true, force: true })
}
console.log('RECORDER INTERVAL COMPLETE: compare/restore race, atomic acquisition, same-value/ABA/source rejection, shared sessions, guarded timers, warnings, failed writes/commit/readback rollback, consumed leases/reopen, real two-connection lock and conservative data_version; memory/new temporary databases only')
