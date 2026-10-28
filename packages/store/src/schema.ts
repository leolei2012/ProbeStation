import type { DuckDBConnection } from '@duckdb/node-api'

/** Transactional, metadata-driven migration. Never infer a response identity. */
export async function ensurePollDataSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run('BEGIN TRANSACTION')
  try {
    await conn.run(`CREATE TABLE IF NOT EXISTS poll_data (
      object_id INTEGER, area VARCHAR DEFAULT 'holding-register', address INTEGER,
      ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR, batch_id VARCHAR
    )`)
    const columns = async () => (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects()
    let cols = await columns()
    const has = (name: string) => cols.some(c => c.name === name)
    if (has('register_id') && has('address')) throw new Error('poll_data has both register_id and address')
    if (!has('address') && has('register_id')) await conn.run('ALTER TABLE poll_data RENAME COLUMN register_id TO address')
    if (!has('area')) await conn.run("ALTER TABLE poll_data ADD COLUMN area VARCHAR DEFAULT 'holding-register'")
    if (!has('batch_id')) await conn.run('ALTER TABLE poll_data ADD COLUMN batch_id VARCHAR')
    cols = await columns()
    const expected = { object_id: 'INTEGER', area: 'VARCHAR', address: 'INTEGER', ts: 'TIMESTAMP', raw_value: 'DOUBLE', quality: 'VARCHAR', batch_id: 'VARCHAR' }
    for (const [name, type] of Object.entries(expected)) {
      const col = cols.find(c => c.name === name)
      if (!col || col.type !== type) throw new Error(`poll_data.${name} must be ${type}; found ${col?.type ?? 'missing'}`)
      if (name === 'batch_id' && (col.notnull || col.dflt_value != null)) throw new Error('poll_data.batch_id must be nullable without a default')
    }
    await conn.run('CREATE INDEX IF NOT EXISTS idx_poll_object_ts ON poll_data(object_id, ts)')
    await conn.run('COMMIT')
  } catch (error) {
    try { await conn.run('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], 'poll_data migration and rollback failed') }
    throw error
  }
}
