import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerPointSettings } from '../packages/api/src/point-settings.ts'
import { AliasEdit } from '../apps/web/src/alias-edit.ts'
import { AliasCell } from '../apps/web/src/AliasCell.tsx'

const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify()
registerPointSettings(app, cfg)
const d = cfg.createObject('synthetic', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'mock', 3, 0, 2), p = cfg.createRegister(g.id, d.id, 'initial', 3, 0, 'uint16')
let writes = 0, refreshes = 0
const expected = () => cfg.getRegisterSettings(p.id)
const get = async (url: string) => { const result = await app.inject({ url }); if (result.statusCode !== 200) throw new Error('HTTP ' + result.statusCode); return result.json() }
const put = async (url: string, body: unknown) => { writes++; const result = await app.inject({ method: 'PUT', url, payload: body }); if (result.statusCode !== 200) throw new Error('HTTP ' + result.statusCode + ' ' + result.json().error); return result.json() }
try {
  for (const id of ['0', '-1', '1e0', '9007199254740992']) assert.equal((await app.inject({ url: '/api/registers/' + id + '/settings' })).statusCode, 400)
  assert.equal((await app.inject({ url: '/api/registers/999/settings' })).statusCode, 404)
  const editor = new AliasEdit(expected()); let notifications = 0
  const unsubscribe = editor.subscribe(() => notifications++)
  editor.edit('my draft'); cfg.updateRegister(p.id, { alias: 'other editor' }); editor.observe(expected())
  assert.equal(editor.getSnapshot().value, 'my draft'); assert.equal(editor.getSnapshot().phase, 'blocked')
  await editor.save(put, () => refreshes++); assert.equal(writes, 0)
  await editor.reload(async () => { throw new Error('read failed') }); assert.equal(editor.getSnapshot().value, 'my draft')
  await editor.reload(get); assert.equal(editor.getSnapshot().value, 'other editor'); assert.equal(editor.getSnapshot().phase, 'clean')
  editor.edit('new alias'); cfg.updateRegister(p.id, { unit: 'concurrent unit', enumJson: '{"1":"keep"}' }); editor.observe(expected())
  assert.equal(editor.getSnapshot().phase, 'dirty', 'unrelated omitted fields may coexist')
  await editor.save(put, () => refreshes++); assert.equal(cfg.getRegister(p.id)!.alias, 'new alias'); assert.equal(cfg.getRegister(p.id)!.unit, 'concurrent unit'); assert.equal(cfg.getRegister(p.id)!.enumJson, '{"1":"keep"}'); assert.equal(refreshes, 1)
  editor.observe(expected()); assert.equal(editor.getSnapshot().phase, 'clean')
  editor.edit(''); await editor.save(put, () => {}); assert.equal(cfg.getRegister(p.id)!.alias, null)
  editor.observe(expected()); editor.edit('blocked source'); cfg.updateGroup(g.id, { slaveId: 2 })
  const beforeWrites = writes
  await editor.save(put, () => {}); assert.equal(editor.getSnapshot().value, 'blocked source'); assert.equal(editor.getSnapshot().phase, 'blocked'); assert.match(editor.getSnapshot().message, /409/)
  await editor.save(put, () => {}); assert.equal(writes, beforeWrites + 1, 'no implicit retry or legacy fallback')
  await editor.reload(get); editor.edit('uncertain draft')
  let release!: (value: unknown) => void
  const pending = editor.save(async () => new Promise(resolve => { release = resolve }), () => {}, 5)
  editor.edit('must not replace pending draft'); await pending
  assert.equal(editor.getSnapshot().value, 'uncertain draft'); assert.equal(editor.getSnapshot().phase, 'blocked'); assert.match(editor.getSnapshot().message, /待核实/)
  release({ point: { ...cfg.getRegister(p.id), alias: 'uncertain draft' }, warnings: [] }); await Promise.resolve()
  assert.equal(editor.getSnapshot().phase, 'blocked', 'late response cannot report success after timeout')
  await editor.reload(get); editor.edit('simultaneous')
  let reply!: (value: unknown) => void
  const saving = editor.save(async (url, body) => { const result = await put(url, body); await new Promise<void>(resolve => { reply = () => resolve() }); return result }, () => {})
  while (!reply) await new Promise(resolve => setTimeout(resolve, 1))
  cfg.updateGroup(g.id, { slaveId: 3 }); editor.observe(expected()); reply(null); await saving
  assert.equal(editor.getSnapshot().phase, 'blocked'); assert.equal(editor.getSnapshot().value, 'simultaneous'); assert.match(editor.getSnapshot().message, /已保存.*又有变化/)
  await editor.reload(get); editor.edit('refresh failed')
  await editor.save(put, () => { throw new Error('refresh failed') }); assert.match(editor.getSnapshot().message, /别名已保存.*刷新未完成/)
  const db = (cfg as any).db
  db.exec("CREATE TRIGGER synthetic_bad_alias AFTER UPDATE OF alias ON registers BEGIN UPDATE registers SET alias='trigger changed' WHERE id=NEW.id; END")
  const snapshot = expected(); assert.throws(() => cfg.updateRegisterSettings(p.id, { expected: snapshot, changes: { alias: 'must rollback' } }), /读回不一致/)
  assert.equal(cfg.getRegister(p.id)!.alias, 'refresh failed'); db.exec('DROP TRIGGER synthetic_bad_alias')
  const html = renderToStaticMarkup(createElement(AliasCell, { point: cfg.getRegister(p.id), group: cfg.getGroup(g.id), device: cfg.getObject(d.id), placeholder: '别名', get, put, onRefresh() {} }))
  assert.match(html, /aria-label="别名"/); assert.match(html, /value="refresh failed"/)
  assert(notifications > 0); unsubscribe()
  console.log('ALIAS EDIT OK: dirty preservation, source/same-field conflict, omitted-field coexistence, explicit reload/failure, one conditional write, NULL clearing, timeout/late response, in-flight refresh, postcommit refresh warning, trigger rollback and SSR; memory API only, no browser DOM')
} finally { await app.close(); (cfg as any).db.close() }
