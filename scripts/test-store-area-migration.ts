import { DuckDBInstance } from '@duckdb/node-api'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBStore } from '../packages/store/src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'probestation-area-migration-'))
const dbPath = join(dir, 'poll.duckdb')
const legacy = await DuckDBInstance.create(dbPath)
const conn = await legacy.connect()
await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
await conn.run("INSERT INTO poll_data VALUES (7, 0, '2026-01-01T00:00:00Z', 123, 'good')")
conn.closeSync(); legacy.closeSync()

const store = new DuckDBStore({ dbPath, flushIntervalMs: 0, flushBatchSize: 100, retentionSeconds: 0, retentionCheckMs: 0 })
const oldRows = await store.query(7, 0, '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'holding-register')
if (oldRows.length !== 1 || oldRows[0].rawValue !== 123) throw new Error('legacy holding-register migration failed')

store.write([{ objectId: 7, area: 'coil', address: 0, timestamp: '2026-01-01T00:00:01Z', rawValue: 1, quality: 'good' }])
await store.flush()
const coils = await store.query(7, 0, '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'coil')
if (coils.length !== 1 || coils[0].rawValue !== 1) throw new Error('new area insert failed after migration')
console.log('STORE AREA MIGRATION TEST OK')
process.exit(0)
