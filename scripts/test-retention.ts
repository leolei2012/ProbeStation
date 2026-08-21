import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'

// ============================================================
// 历史数据保留回归（PRD 08 需求二）
// 全局默认 + 设备级 data_retain_seconds 覆盖；0=永久；NULL=跟随全局。
// ============================================================

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:', retentionSeconds: 600, retentionCheckMs: 0 }) // 全局 10 分钟，禁用周期清理

const cfg = ctx.get('config', false)
const store = ctx.get('store', false)

const now = new Date()
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

const a = cfg.createObject('A-全局', '127.0.0.1', 502) // 跟随全局 600s
const b = cfg.createObject('B-覆盖', '127.0.0.1', 502, 'master', { dataRetainSeconds: 60 }) // 覆盖 60s

store.write([
  { objectId: a.id, area: 'holding-register', address: 0, timestamp: iso(2 * 3600 * 1000), rawValue: 111, quality: 'good' }, // A 的 2h 前 → 应删
  { objectId: a.id, area: 'holding-register', address: 1, timestamp: iso(5 * 60 * 1000), rawValue: 222, quality: 'good' },   // A 的 5min 前 → 全局 600s 内 → 保留
  { objectId: b.id, area: 'holding-register', address: 0, timestamp: iso(5 * 60 * 1000), rawValue: 333, quality: 'good' },   // B 的 5min 前 → 覆盖 60s 外 → 删
  { objectId: b.id, area: 'holding-register', address: 1, timestamp: iso(10 * 1000), rawValue: 444, quality: 'good' },       // B 的 10s 前 → 保留
])
await store.flush()
await store.cleanup()

const ra = await store.queryObject(a.id, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
const rb = await store.queryObject(b.id, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')

const raAddr = ra.map((p) => p.address).sort()
const rbAddr = rb.map((p) => p.address).sort()

if (JSON.stringify(raAddr) !== JSON.stringify([1])) throw new Error('A retention wrong: ' + JSON.stringify(raAddr) + ' (expect only addr 1)')
if (JSON.stringify(rbAddr) !== JSON.stringify([1])) throw new Error('B retention wrong: ' + JSON.stringify(rbAddr) + ' (expect only addr 1)')

console.log('A (global 600s) kept addr:', JSON.stringify(raAddr), '| B (override 60s) kept addr:', JSON.stringify(rbAddr))

// 永久保留：0 = 不清理
store.setRetentionSeconds(0)
await store.cleanup()
const raAfter = await store.queryObject(a.id, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
if (raAfter.length === 0) throw new Error('retention=0 should keep data')

console.log('retention=0 forever OK (still ' + raAfter.length + ' rows)')
console.log('RETENTION TEST OK')
process.exit(0)
