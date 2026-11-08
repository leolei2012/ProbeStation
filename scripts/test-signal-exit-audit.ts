import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/signal-exit-audit-child.mjs', import.meta.url)), folder = mkdtempSync(join(tmpdir(), 'probestation-signal-audit-'))
const main = readFileSync(new URL('../apps/cli/src/main.ts', import.meta.url), 'utf8')
assert(!/process\.(?:on|once)\(['"]SIG(?:INT|TERM)['"]/.test(main), 'audit assumes the unchanged application entry has no signal hooks')
assert(main.indexOf('await assertPortsAvailable') < main.indexOf('const ctx = new Context'))
assert(main.indexOf("ctx.get('poller', false).startAll()") < main.indexOf('await app.listen'))
const env: NodeJS.ProcessEnv = {}
for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name]
Object.assign(env, { USERPROFILE: folder, APPDATA: folder, LOCALAPPDATA: folder, TEMP: folder, TMP: folder, PROBESTATION_DATA_DIR: folder })
const results: any[] = []
function spawn(options: Record<string, unknown>) {
  const events: any[] = [], child = fork(fixture, [JSON.stringify(options)], { cwd: folder, env, execArgv: [], silent: true, windowsHide: true })
  assert(child.pid && child.pid !== process.pid)
  let ended = false, outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined, stderr = ''
  const waiters = new Set<() => void>()
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
  child.stdout?.resume()
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { ended = true; outcome = { code, signal }; for (const notify of waiters) notify(); done(outcome) })
  })
  child.on('message', event => { events.push(event); for (const notify of waiters) notify() })
  const send = (message: object) => new Promise<void>((done, reject) => child.send(message, error => error ? reject(error) : done()))
  const wait = (type: string, predicate: (event: any) => boolean = () => true) => new Promise<any>((done, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('signal audit timeout: ' + type + ' ' + stderr)) }, 5000)
    const check = () => {
      const found = events.find(event => event.type === type && predicate(event))
      if (found || ended) { clearTimeout(timer); waiters.delete(check); found ? done(found) : reject(new Error('audit child exited before ' + type + ': ' + JSON.stringify(outcome) + ' ' + stderr)) }
    }
    waiters.add(check); check()
  })
  const finish = async () => {
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL') }, 5000)
    try { return await exit } finally { clearTimeout(timer) }
  }
  const dispose = async () => {
    if (!ended && child.connected) await send({ type: 'stop' }).catch(() => {})
    await finish()
  }
  return { child, events, send, wait, finish, dispose }
}
try {
  // OS delivery: only this child object's handle is targeted, never a discovered PID or service.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    let baseline: { code: number | null; signal: NodeJS.Signals | null } | undefined
    for (const mode of ['baseline', 'candidate'] as const) {
      const probe = spawn({ mode })
      try {
        await probe.wait('ready'); assert.equal(probe.child.kill(signal), true)
        if (process.platform !== 'win32' && mode === 'candidate') { await probe.wait('step', event => event.name === 'store'); await probe.send({ type: 'release' }) }
        const outcome = await probe.finish()
        const cleaned = probe.events.some(event => event.type === 'cleanup-complete')
        if (process.platform === 'win32') { assert.equal(cleaned, false); assert(!probe.events.some(event => event.type === 'cleanup-start')) }
        if (mode === 'baseline') baseline = outcome
        else if (process.platform === 'win32') assert.deepEqual(outcome, baseline, 'Windows force termination is not intercepted by installed JS listeners')
        results.push({ delivery: 'owned-child.kill', signal, mode, outcome, cleaned })
      } finally { await probe.dispose() }
    }
  }
  const unhandled = spawn({ mode: 'baseline' })
  try {
    await unhandled.wait('ready'); await unhandled.send({ type: 'emit', signal: 'SIGINT' }); assert.equal((await unhandled.wait('emitted')).handled, false)
    await unhandled.send({ type: 'stop' }); results.push({ delivery: 'synthetic-event-only', mode: 'baseline', outcome: await unhandled.finish() })
  } finally { await unhandled.dispose() }
  for (const scenario of [
    { name: 'int-clean', signal: 'SIGINT' }, { name: 'term-clean', signal: 'SIGTERM' },
    { name: 'repeat-coalesced', signal: 'SIGINT', repeat: 'coalesce', duplicate: true },
    { name: 'repeat-force', signal: 'SIGINT', repeat: 'force', duplicate: true },
    { name: 'failed-preserve-cause', signal: 'SIGINT', fail: 'store' },
    { name: 'failed-code-one', signal: 'SIGTERM', fail: 'store', failureCode: 'one' },
    { name: 'startup-failed', signal: 'SIGINT', startup: true, fail: 'store' },
    { name: 'restore-default', signal: 'SIGINT', restoreDefault: true },
  ] as const) {
    const options = scenario as any, probe = spawn({ mode: 'candidate', repeat: options.repeat, fail: options.fail, failureCode: options.failureCode, restoreDefault: options.restoreDefault })
    try {
      await probe.wait('ready'); await probe.send(options.startup ? { type: 'startup-failure' } : { type: 'emit', signal: options.signal })
      await probe.wait('step', event => event.name === 'store')
      if (options.duplicate) { await probe.send({ type: 'emit', signal: 'SIGTERM' }); await probe.wait('duplicate') }
      if (options.repeat === 'force') {
        const forced = await probe.wait('forced'); const outcome = await probe.finish()
        assert.equal(outcome.code, 130); assert.equal(forced.pendingRows, 2); assert.equal(forced.counts.config, 0); assert(!probe.events.some(event => event.type === 'cleanup-complete'))
        results.push({ delivery: 'synthetic-event-only', name: options.name, outcome, forced })
      } else {
        await probe.send({ type: 'release' }); const completed = await probe.wait('cleanup-complete'), finished = await probe.wait('finished'), outcome = await probe.finish()
        assert.deepEqual(completed.counts, { api: 1, store: 1, config: 1 }); assert.equal(probe.events.filter(event => event.type === 'cleanup-start').length, 1)
        assert.equal(completed.pendingRows, options.fail ? 2 : 0)
        if (options.startup) { assert.equal(outcome.code, 1); assert(finished.primaryPreserved); assert(finished.errors.includes('synthetic startup failure')) }
        else if (!options.restoreDefault) assert.equal(outcome.code, options.failureCode === 'one' ? 1 : options.signal === 'SIGINT' ? 130 : 143)
        if (options.fail) assert(finished.errors.includes('synthetic store cleanup failure'))
        results.push({ delivery: 'synthetic-event-only', name: options.name, outcome, counts: completed.counts, pendingRows: completed.pendingRows, errors: finished.errors })
      }
    } finally { await probe.dispose() }
  }
  console.log('SIGNAL AUDIT ' + JSON.stringify({ platform: process.platform, node: process.version, results, productionEntryImported: false, productionSignalHooksInstalled: false, childFixtureOnly: true }))
} finally {
  assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert(folder.startsWith(join(tmpdir(), 'probestation-signal-audit-'))); rmSync(folder, { recursive: true, force: true })
}
