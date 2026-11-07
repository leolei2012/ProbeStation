import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { apply } from '../packages/workspace/src/index.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'probestation-export-pair-'))
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const unavailable = (error: unknown) => (error as any)?.code === 'WORKSPACE_EXPORT_PAIR_INVALID'
let counter = 0
function fixture(capable = true) {
  const effects: string[] = [], hooks: Record<string, () => void | Promise<void>> = {}
  let cfgScope = 'config-0', storeScope = 'store-0', workspace: any
  const handles = new WeakSet<object>()
  const config: any = { reopen() { effects.push('config'); cfgScope = 'config-' + ++counter; return hooks.config?.() } }
  const store: any = { async reopen() { effects.push('store'); storeScope = 'store-' + ++counter; await hooks.store?.() } }
  if (capable) {
    config.getHistoryExportConfigurationScope = () => cfgScope
    config.getHistoryExportConfiguration = (id: number) => Object.freeze({ version: 1, configurationScope: cfgScope, device: Object.freeze({ id }), groups: Object.freeze([]), registers: Object.freeze([]) })
    store.captureExportReadHandle = () => { const handle = Object.freeze({ version: 1, storeScope }); handles.add(handle); return handle }
    store.validateExportReadHandle = (handle: any) => { if (!handles.has(handle) || handle.storeScope !== storeScope) throw new Error('mock store ownership invalid') }
  }
  const ctx: any = { config, store, poller: { async stopAll() { effects.push('stop'); await hooks.stop?.() }, startAll() { effects.push('start'); hooks.start?.() } }, emit() { effects.push('emit'); hooks.emit?.() }, provide(_name: string, service: any) { workspace = service } }
  const folder = join(root, 'fixture-' + ++counter)
  apply(ctx, { defaultWorkspace: folder, registryPath: join(folder, 'registry.json') })
  return { workspace, ctx, config, store, effects, hooks, folder }
}
let cfg: ConfigStore | undefined, real: DuckDBStore | undefined
try {
  const f = fixture(), ws = f.workspace, target = join(f.folder, 'target')
  assert.throws(() => ws.captureHistoryExportPair(1), unavailable, 'startup does not infer pairing from two independently opened providers')
  await ws.switchTo(target); assert.deepEqual(f.effects, ['stop', 'store', 'config', 'emit', 'start'])
  const first = ws.captureHistoryExportPair(1); ws.validateHistoryExportPair(first)
  assert(Object.isFrozen(first)); assert(Object.isFrozen(first.configuration)); assert.equal(first.configuration.device.id, 1)
  assert.deepEqual(Object.keys(first).sort(), ['configuration', 'storeHandle', 'version', 'workspaceScope'])
  for (const foreign of [{ ...first }, JSON.parse(JSON.stringify(first)), fixture().workspace, null, undefined]) assert.throws(() => ws.validateHistoryExportPair(foreign), unavailable)
  const foreignWorkspace = fixture(); await foreignWorkspace.workspace.switchTo(join(foreignWorkspace.folder, 'target'))
  assert.throws(() => ws.validateHistoryExportPair(foreignWorkspace.workspace.captureHistoryExportPair(1)), unavailable)
  ws.validateHistoryExportPair(first)

  const entered = defer(), release = defer()
  f.hooks.stop = async () => { entered.resolve(); await release.promise }
  const switching = ws.switchTo(target); await entered.promise
  assert.throws(() => ws.captureHistoryExportPair(1), unavailable); assert.throws(() => ws.validateHistoryExportPair(first), unavailable)
  const effectCount = f.effects.length
  await assert.rejects(ws.switchTo(join(f.folder, 'concurrent')), /already switching/); assert.equal(f.effects.length, effectCount)
  const partial = defer(), continueStore = defer()
  f.hooks.store = async () => { partial.resolve(); await continueStore.promise }
  release.resolve(); await partial.promise
  const newHandle = f.store.captureExportReadHandle(); assert.notEqual(newHandle.storeScope, first.storeHandle.storeScope)
  assert.equal(f.config.getHistoryExportConfigurationScope(), first.configuration.configurationScope, 'reproduce new store + old configuration window')
  assert.throws(() => ws.captureHistoryExportPair(1), unavailable, 'a fresh store handle alone cannot authorize a pair')
  f.hooks.config = () => { assert.throws(() => ws.captureHistoryExportPair(1), unavailable) }
  f.hooks.emit = () => { assert.throws(() => ws.captureHistoryExportPair(1), unavailable) }
  continueStore.resolve(); await switching
  const second = ws.captureHistoryExportPair(1); assert.notEqual(second.workspaceScope, first.workspaceScope); ws.validateHistoryExportPair(second)
  delete f.hooks.stop; delete f.hooks.store; delete f.hooks.config; delete f.hooks.emit

  for (const stage of ['stop', 'store', 'config', 'emit', 'start']) {
    const error = new Error('mock failure at ' + stage), before = ws.captureHistoryExportPair(1)
    f.hooks[stage] = () => { throw error }
    await assert.rejects(ws.switchTo(target), value => value === error)
    assert.throws(() => ws.captureHistoryExportPair(1), unavailable); assert.throws(() => ws.validateHistoryExportPair(before), unavailable)
    delete f.hooks[stage]; await ws.switchTo(target); ws.validateHistoryExportPair(ws.captureHistoryExportPair(1))
  }
  const notDirectory = join(f.folder, 'file'); writeFileSync(notDirectory, 'fixture')
  await assert.rejects(ws.switchTo(notDirectory)); assert.throws(() => ws.captureHistoryExportPair(1), unavailable); await ws.switchTo(target)
  for (const kind of ['config', 'store', 'replace']) {
    const pair = ws.captureHistoryExportPair(1)
    if (kind === 'replace') f.ctx.config = { ...f.config }
    else await f[kind].reopen()
    assert.throws(() => ws.validateHistoryExportPair(pair), unavailable)
    assert.throws(() => ws.captureHistoryExportPair(1), unavailable)
    f.ctx.config = f.config; await ws.switchTo(target)
  }
  // Reopen from an event callback must not be silently accepted as the completed pair.
  f.hooks.emit = () => { f.config.reopen() }; await ws.switchTo(target)
  assert.throws(() => ws.captureHistoryExportPair(1), unavailable); delete f.hooks.emit; await ws.switchTo(target)
  for (const kind of ['store', 'config']) {
    f.hooks[kind] = () => { f.ctx[kind] = { ...f[kind] } }
    await ws.switchTo(target)
    assert.throws(() => ws.captureHistoryExportPair(1), unavailable, 'must bind the exact providers actually reopened, not their replacements')
    f.ctx[kind] = f[kind]; delete f.hooks[kind]; await ws.switchTo(target)
  }
  const noCapability = fixture(false); await noCapability.workspace.switchTo(join(noCapability.folder, 'target'))
  assert.deepEqual(noCapability.effects, ['stop', 'store', 'config', 'emit', 'start']); assert.throws(() => noCapability.workspace.captureHistoryExportPair(1), unavailable)
  const oldScope = f.config.getHistoryExportConfigurationScope, beforeMetadataFailure = ws.captureHistoryExportPair(1)
  f.config.getHistoryExportConfigurationScope = () => { throw new Error('PRIVATE mock metadata error') }
  assert.throws(() => ws.validateHistoryExportPair(beforeMetadataFailure), error => unavailable(error) && !(error as Error).message.includes('PRIVATE'))
  await ws.switchTo(target); assert.throws(() => ws.captureHistoryExportPair(1), unavailable, 'optional metadata failure must not change legacy switch success')
  f.config.getHistoryExportConfigurationScope = oldScope; assert.throws(() => ws.captureHistoryExportPair(1), unavailable)
  await ws.switchTo(target); ws.validateHistoryExportPair(ws.captureHistoryExportPair(1))

  // Real SQLite/DuckDB strictly in memory, behind explicit adapters rejecting file paths outside this fixture.
  cfg = new ConfigStore({ dbPath: ':memory:' })
  real = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 }, cfg)
  await (real as any).ready
  const m = fixture(), memoryFolder = join(m.folder, 'memory')
  const within = (path: string, file: string) => assert.equal(resolve(path), resolve(memoryFolder, file))
  const seed = () => { const device = cfg!.createObject('synthetic', 'mock.invalid', 502), group = cfg!.createGroup(device.id, 'group', 3, 0, 1, 'read', 1); cfg!.createRegister(group.id, device.id, 'point', 3, 0, 'uint16'); return device }
  seed()
  m.ctx.config = { reopen(path: string) { within(path, 'config.db'); cfg!.reopen(':memory:'); seed() }, getHistoryExportConfigurationScope: () => cfg!.getHistoryExportConfigurationScope(), getHistoryExportConfiguration: (id: number) => cfg!.getHistoryExportConfiguration(id) }
  m.ctx.store = { async reopen(path: string) { within(path, 'poll.duckdb'); await real!.reopen(':memory:') }, captureExportReadHandle: () => real!.captureExportReadHandle(), validateExportReadHandle: (handle: any) => real!.validateExportReadHandle(handle) }
  await m.workspace.switchTo(memoryFolder)
  const pair = m.workspace.captureHistoryExportPair(1), start = '2026-11-07T00:00:00Z', end = '2026-11-07T00:00:01Z'
  assert.throws(() => m.workspace.captureHistoryExportPair(999), error => (error as any)?.statusCode === 404)
  m.workspace.validateHistoryExportPair(pair)
  real.write([{ objectId: 1, area: 'holding-register', address: 0, timestamp: start, rawValue: 10, quality: 'good', batchId: 'response', slaveId: 1 }]); await real.flush()
  assert.equal((await real.queryObjectForExportWithHandle(pair.storeHandle, pair.configuration.device.id, start, end))[0].rawValue, 10)
  m.workspace.validateHistoryExportPair(pair)
  cfg.updateObject(1, { name: 'changed in same open lifetime' }); m.workspace.validateHistoryExportPair(pair)
  assert.equal(pair.configuration.device.name, 'synthetic', 'a lifecycle pair is not a content revision')
  const mutationBarrier = defer(); (real as any).mutations = mutationBarrier.promise
  const pendingRows = real.queryObjectForExportWithHandle(pair.storeHandle, 1, start, end)
  cfg.reopen(':memory:'); seed(); mutationBarrier.resolve()
  assert.equal((await pendingRows)[0].rawValue, 10, 'store-only ownership does not detect a configuration-only reopen')
  assert.throws(() => m.workspace.validateHistoryExportPair(pair), unavailable, 'the required post-await pair validation detects configuration-only reopen')
  assert.throws(() => m.workspace.captureHistoryExportPair(1), unavailable)
  await m.workspace.switchTo(memoryFolder); assert.throws(() => m.workspace.validateHistoryExportPair(pair), unavailable)
  const fresh = m.workspace.captureHistoryExportPair(1); assert.notEqual(fresh.workspaceScope, pair.workspaceScope)
  assert.deepEqual(await real.queryObjectForExportWithHandle(fresh.storeHandle, 1, start, end), [])
  cfg.reopen(':memory:'); assert.throws(() => m.workspace.validateHistoryExportPair(fresh), unavailable)
  console.log('WORKSPACE EXPORT PAIR OK: actual retained service with stop/store/config/event/start barriers, initial denial, concurrency, same-path generations, partial failures/recovery, provider replacement and direct reopen invalidation; real memory configuration/store and captured definitions; legacy calls compatible, no API integration, main bootstrap, hardware or user data')
} finally {
  if (real) { await (real as any).mutations; const conn = await (real as any).ready.catch(() => null); conn?.closeSync(); (real as any).instance?.closeSync() }
  ;(cfg as any)?.db.close()
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('probestation-export-pair-')); rmSync(root, { recursive: true, force: true })
}
