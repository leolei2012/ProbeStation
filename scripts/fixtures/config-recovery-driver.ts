import assert from 'node:assert/strict'
import { mkdtempSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ConfigStore } from '../../packages/config/src/index.ts'

/** Preserve an existing memory-only test's committed rows/IDs before injecting a rollback fault. */
export function stageMemoryConfigurationRecovery(cfg: ConfigStore) {
  const fixture = cfg as unknown as { dbPath: string; db: DatabaseSync }
  assert.equal(fixture.dbPath, ':memory:', 'Never copy a real/configured database in this test helper')
  const db = fixture.db
  assert.equal(db.isTransaction, false)
  const tables = ['monitor_objects', 'register_groups', 'registers', 'alarm_rules', 'logs', 'firmwares']
  const originalRows = () => JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])))
  const committedRows = originalRows()
  const directory = mkdtempSync(join(tmpdir(), 'probestation-memory-recovery-')), file = join(directory, 'synthetic.sqlite')
  db.prepare('VACUUM INTO ?').run(file)
  return {
    reopen() {
      assert.equal(db.isTransaction, false)
      assert.equal(originalRows(), committedRows, 'the original memory database itself must be restored before opening the committed fixture copy')
      cfg.reopen(file) // Explicit test recovery, never an automatic retry or production backup flow.
    },
    async close() {
      await cfg.close()
      const target = resolve(directory)
      assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase())
      assert(basename(target).startsWith('probestation-memory-recovery-'))
      assert(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink())
      rmSync(target, { recursive: true, force: true })
    },
  }
}
