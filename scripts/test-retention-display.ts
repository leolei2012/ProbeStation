import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { deviceRetentionPolicy, retentionDisplay, formatRetentionSeconds } from '../packages/core/src/retention-policy.ts'
import { RetentionSummary } from '../apps/web/src/RetentionSummary.tsx'

// Isolated memory database only; no app, config file, service listeners or device connections.
const close = async (store: DuckDBStore) => { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  const short = cfg.createObject('Short', '', 502, 'master', { dataRetainSeconds: 60 })
  const forever = cfg.createObject('Forever', '', 502, 'master', { dataRetainSeconds: 0 })
  const inherit = cfg.createObject('Inherit', '', 502)
  const long = cfg.createObject('Long', '', 502, 'master', { dataRetainSeconds: 1200 })
  const snapshot = () => { const { createdAt: _generated, ...data } = cfg.exportBackup(); return data }
  const devices = [short, forever, inherit, long], before = snapshot()
  for (const global of [600, 0]) {
    const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: global, retentionCheckMs: 0 }, cfg)
    try {
      await (store as any).ready; await (store as any).mutations
      const cleanup = store.cleanup.bind(store); let cleanupCalls = 0
      store.cleanup = async () => { cleanupCalls++; await cleanup() }
      const now = Date.now()
      store.write(devices.flatMap(device => [900, 300, 10].map((seconds, address) => ({ objectId: device.id, area: 'holding-register' as const, address, timestamp: new Date(now - seconds * 1000).toISOString(), rawValue: address + 1, quality: 'good' }))))
      await store.flush()
      for (const device of devices) {
        const stats = await store.statsByObject(device.id), retention = JSON.parse(JSON.stringify(stats.retention))
        const expected = device.dataRetainSeconds ?? global
        assert.equal(retention.policy?.seconds, expected, 'selected device must report its override, not only global retention')
        assert.equal(retention.retention_seconds, global, 'legacy field remains the global default for compatibility')
        assert.equal(retention.policy.objectId, device.id); assert.equal(retention.policy.source, device.dataRetainSeconds === null ? 'global' : 'device')
        assert.equal(retentionDisplay(retention, device.id).seconds, expected); assert.equal(stats.totalRows, 3)
      }
      assert.equal(cleanupCalls, 0, 'stats and policy reads must never trigger cleanup')
      assert.deepEqual(snapshot(), before, 'reads do not edit device configuration')
      assert.equal((await store.stats()).totalRows, 12)
      assert.equal((await store.statsByObject(999)).retention.policy.source, 'global', 'unconfigured historical IDs follow existing cleanup default')
      await store.cleanup()
      const rows = async (id: number) => (await store.queryObject(id, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).map(p => p.address).sort()
      assert.deepEqual(await rows(short.id), [2]); assert.deepEqual(await rows(forever.id), [0, 1, 2]); assert.deepEqual(await rows(long.id), [0, 1, 2]); assert.deepEqual(await rows(inherit.id), global === 0 ? [0, 1, 2] : [1, 2])
      assert.equal(cleanupCalls, 1, 'explicit memory-only cleanup retains its original semantics')
      cfg.updateObject(short.id, { dataRetainSeconds: 61 })
      assert.equal((await store.statsByObject(short.id)).retention.policy.seconds, 61, 'a new read sees the new configured value')
      cfg.updateObject(short.id, { dataRetainSeconds: 60 })
      const list = cfg.listObjects.bind(cfg); cfg.listObjects = () => { throw new Error('synthetic metadata read failure') }
      try { await assert.rejects(store.statsByObject(short.id), /synthetic metadata read failure/) } finally { cfg.listObjects = list }
    } finally { await close(store) }
  }
} finally { (cfg as any).db.close() }
const standalone = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 600, retentionCheckMs: 0 })
try { assert.equal((await standalone.statsByObject(1)).retention.policy.seconds, 600) } finally { await close(standalone) }

for (const seconds of [-1, 1.5, NaN, Infinity, '60', Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(deviceRetentionPolicy(600, 1, [{ id: 1, dataRetainSeconds: seconds as number }]).source, 'unverified')
  assert.equal(formatRetentionSeconds(seconds), '—')
}
assert.equal(deviceRetentionPolicy(-1, 1, []).seconds, null)
assert.equal(deviceRetentionPolicy(600, 1, []).seconds, 600)
const policy = (seconds = 60, source = 'device', objectId = 1) => ({ retention_seconds: 600, policy: { version: 1, objectId, source, seconds } })
assert.deepEqual(retentionDisplay({ retention_seconds: 600 }, 1), { globalSeconds: 600, seconds: null, source: 'unverified' }, 'old responses do not prove a device policy')
assert.deepEqual(retentionDisplay({ retention_seconds: 600 }, null), { globalSeconds: 600, seconds: 600, source: 'global' })
for (const input of [undefined, null, {}, [], policy(60, 'global'), policy(60, 'device', 2), policy(-1), policy(60, 'healthy'), { ...policy(), policy: { ...policy().policy, version: 2 } }, { ...policy(), retention_seconds: '600' }, { ...policy(), policy: { ...policy().policy, seconds: '60' } }]) assert.equal(retentionDisplay(input, 1).source, 'unverified')
assert.equal(retentionDisplay(policy(0), 1).seconds, 0)
assert.equal(retentionDisplay(policy(600, 'global'), 1).source, 'global')
assert.equal(retentionDisplay(policy(), 2).seconds, null, 'scope changes cannot display a prior device override as current')
assert.equal(formatRetentionSeconds(0), '永久'); assert.equal(formatRetentionSeconds(1), '1 秒'); assert.equal(formatRetentionSeconds(59), '59 秒'); assert.equal(formatRetentionSeconds(60), '1 分钟'); assert.equal(formatRetentionSeconds(61), '1 分钟 1 秒'); assert.equal(formatRetentionSeconds(3600), '1 小时'); assert.equal(formatRetentionSeconds(86400), '1 天'); assert.equal(formatRetentionSeconds(90061), '1 天 1 小时 1 分钟 1 秒'); assert.equal(formatRetentionSeconds(Number.MAX_SAFE_INTEGER).includes('—'), false)
assert.equal(formatRetentionSeconds(0, true), 'Forever'); assert.equal(formatRetentionSeconds(90061, true), '1 d 1 h 1 min 1 s')
for (const english of [false, true]) {
  const render = (retention: unknown, objectId: number | null = 1) => renderToStaticMarkup(createElement(RetentionSummary, { retention, objectId, english }))
  const override = render(policy()); assert(override.includes(english ? 'Device override' : '设备独立设置')); assert(override.includes(english ? '1 min' : '1 分钟')); assert(!override.includes(english ? '0 days' : '0 天'))
  assert(render(policy(0)).includes(english ? 'Forever' : '永久')); assert(render(policy(600, 'global')).includes(english ? 'Inherits global' : '跟随全局'))
  assert(render({ retention_seconds: 600 }).includes(english ? 'Effective policy unverified' : '实际策略未核实'))
  assert(render(policy(60, 'device', 2)).includes(english ? 'Effective policy unverified' : '实际策略未核实'))
  assert(render({ retention_seconds: 600 }, null).includes(english ? 'Devices can override' : '设备可独立覆盖'))
  assert(!render(undefined).includes(english ? 'Forever' : '永久')); assert(!override.includes('<button')); assert(override.includes(english ? 'read-only' : '只读'))
}
console.log('RETENTION DISPLAY OK: real memory ConfigStore/DuckDB overrides, zero/inheritance/short/long/global forever, unchanged cleanup and legacy fields, read-only stats, metadata failures, JSON/scope/legacy validation, exact durations and bilingual production SSR; no real data, listeners, hardware, model or browser automation')
