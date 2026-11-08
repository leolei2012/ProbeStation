import assert from 'node:assert/strict'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'
import ts from 'typescript'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerDeviceSettings } from '../packages/api/src/device-settings.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { saveGuardedDeviceSettings } from '../apps/web/src/device-settings-save.ts'
import { draftEditor } from './fixtures/draft-navigation-driver.ts'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const request = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
const adapter = (fetcher: unknown) => new Function('fetch', 'configurationWriteReceipt', 'CONFIG_WRITE_NOT_STARTED', ts.transpileModule('return (' + request.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(fetcher, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED)
const tick = () => new Promise<void>(done => setImmediate(done))
const failures: string[] = [], unhandled: unknown[] = [], passed: string[] = []
const collect = (error: unknown) => unhandled.push(error)
async function check(name: string, action: () => Promise<void>) { try { await action(); passed.push(name); console.log('DEVICE WRITE QUARANTINE OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('DEVICE WRITE QUARANTINE REPRO: ' + failures.at(-1)) } }
process.on('unhandledRejection', collect)
try {
  for (const acknowledged of [false, true]) await check('uncertain-original-versus-blocked-next-request-commit-' + acknowledged, async () => {
    let notifications = 0, hooks = 0, requests = 0
    const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { notifications++ }), app = Fastify()
    const device = cfg.createObject('synthetic', 'mock.invalid', 502, 'master', { serialPath: 'SYNTHETIC_PORT' }), expected = captureDeviceEditBaseline(device), db = (cfg as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db), prepare = db.prepare.bind(db)
    registerDeviceSettings(app, cfg, { reconnect: async () => { hooks++ }, syncSlaves: async () => { hooks++ } })
    let lastStatus = 0, lastBody: any
    const actualRequest = adapter(async (url: string, options: RequestInit) => {
      assert.equal(options.method, 'PUT'); requests++
      const response = await app.inject({ method: 'PUT', url, payload: JSON.parse(String(options.body)) }); lastStatus = response.statusCode; lastBody = response.json()
      assert(!response.body.includes('PRIVATE'))
      return { ok: response.statusCode < 400, status: response.statusCode, text: async () => response.body, json: async () => response.json() }
    })
    async function edit(message: RegExp) {
      let pending: Promise<unknown> | undefined
      const editor = draftEditor('device', undefined, async (fields, baseline) => { pending = saveGuardedDeviceSettings(baseline, fields, (url, body) => actualRequest(url, { method: 'PUT', body: JSON.stringify(body) })); await pending }, null, undefined, { ...expected, serialPath: expected.serialPath! })
      try {
        editor.change('UNSAVED QUARANTINE DRAFT'); editor.submit(); assert(pending); await pending.catch(() => {}); await tick(); editor.driver.render()
        assert.match(editor.driver.one('div', props => props.role === 'alert').props.children, message)
        assert.equal(editor.value(), 'UNSAVED QUARANTINE DRAFT'); assert.equal(editor.calls.close, 0); assert.equal(editor.calls.save, 1)
        await tick(); assert.equal(editor.calls.save, 1, 'no automatic replay after a rejected/uncertain save')
        editor.close(); editor.resume(); assert.equal(editor.value(), 'UNSAVED QUARANTINE DRAFT'); assert.equal(editor.calls.close, 0)
      } finally { editor.driver.dispose() }
    }
    try {
      const before = notifications
      db.exec = sql => { if (sql === 'COMMIT') { if (acknowledged) exec(sql); throw Error('PRIVATE commit acknowledgement') }; if (sql === 'ROLLBACK') throw Error('PRIVATE rollback'); return exec(sql) }
      await edit(/保存结果待核实/); assert.equal(lastStatus, 500); assert.equal(lastBody.code, undefined); assert.equal(requests, 1); assert.equal(cfg.getConfigurationReadinessStatus().phase, 'quarantined')
      db.exec = () => assert.fail('a blocked new request must execute no SQL'); db.prepare = () => assert.fail('a blocked new request must prepare no SQL')
      await edit(/本次保存未执行/); assert.equal(lastStatus, 503); assert.deepEqual(lastBody, { error: '配置连接已隔离，本次保存未执行。请管理员核查并恢复，勿重复保存；之前请求结果仍须单独核实。', version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' })
      assert.equal(requests, 2); assert.equal(hooks, 0); assert.equal(notifications, before)
      db.exec = exec; db.prepare = prepare
      assert.equal(db.isTransaction, !acknowledged, 'the same draft may be pending or already committed despite the same unknown response')
      assert.equal(db.prepare('SELECT name FROM monitor_objects WHERE id = ?').get(device.id)?.name, 'UNSAVED QUARANTINE DRAFT')
    } finally { db.exec = exec; db.prepare = prepare; if (db.isTransaction) exec('ROLLBACK'); await app.close(); await cfg.close() }
  })
  await check('only-explicit-versioned-request-rejection-is-definite', async () => {
    const cfg = new ConfigStore({ dbPath: ':memory:' }), device = cfg.createObject('synthetic', 'mock.invalid', 502), expected = captureDeviceEditBaseline(device)
    try {
      for (const value of [{}, { version: 2, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }, { version: 1, code: 'CONFIG_TRANSACTION_UNCONFIRMED', outcome: 'not-applied' }, { version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'unknown' }]) {
        let calls = 0
        const put = adapter(async () => { calls++; return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'PRIVATE unsupported', ...value }) } })
        await assert.rejects(saveGuardedDeviceSettings(expected, { name: 'draft' }, (url, body) => put(url, { method: 'PUT', body: JSON.stringify(body) })), /结果待核实/); assert.equal(calls, 1)
      }
      for (const status of [500, 502, 504]) {
        const put = adapter(async () => ({ ok: false, status, text: async () => JSON.stringify({ error: 'PRIVATE', version: 1, code: 'CONFIG_WRITE_NOT_STARTED', outcome: 'not-applied' }) }))
        await assert.rejects(saveGuardedDeviceSettings(expected, { name: 'draft' }, (url, body) => put(url, { method: 'PUT', body: JSON.stringify(body) })), /结果待核实/)
      }
      let calls = 0
      await assert.rejects(saveGuardedDeviceSettings(expected, { name: 'draft' }, async () => { calls++; throw Error('response lost after request') }), /结果待核实/); assert.equal(calls, 1)
    } finally { await cfg.close() }
  })
  await check('legacy-provider-without-status-preserves-unknown-outcome', async () => {
    const app = Fastify(); let attempts = 0
    registerDeviceSettings(app, { updateObjectSettings() { attempts++; throw Error('PRIVATE old provider') } }, { reconnect: async () => assert.fail(), syncSlaves: async () => assert.fail() })
    try { const response = await app.inject({ method: 'PUT', url: '/api/monitor_objects/1/settings', payload: {} }); assert.equal(response.statusCode, 500); assert.equal(response.json().code, undefined); assert.equal(attempts, 1); assert(!response.body.includes('PRIVATE')) }
    finally { await app.close() }
  })
  await tick(); assert.deepEqual(failures, []); assert.deepEqual(unhandled, [])
} finally { process.off('unhandledRejection', collect) }
console.log('DEVICE WRITE QUARANTINE TEST OK: ' + passed.length + ' real-memory transaction/actual HTTP adapter/actual modal/legacy groups; no automatic retry, listeners, hardware, real data or recovery')
