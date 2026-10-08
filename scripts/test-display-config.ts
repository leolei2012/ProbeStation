import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConfigStore } from '../packages/config/src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'probe-display-'))
const path = join(dir, 'config.db')
let cfg = new ConfigStore({ dbPath: path })
try {
  const device = cfg.createObject('Display test', '', 502, 'master')
  const group = cfg.createGroup(device.id, 'Test', 3, 0, 1)
  const reg = cfg.createRegister(group.id, device.id, 'Temperature', 3, 0, 'uint16', { factor: 0.1, unit: '℃' })
  assert.equal(reg.decimalPlaces, null)
  ;(cfg as any).db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE registers DROP COLUMN decimal_places')
  legacy.close()
  cfg = new ConfigStore({ dbPath: path })
  assert.equal(cfg.getRegister(reg.id)?.factor, 0.1)
  assert.equal(cfg.getRegister(reg.id)?.decimalPlaces, null)
  for (const decimalPlaces of [0, 2, 8, null]) {
    cfg.updateRegister(reg.id, { decimalPlaces })
    assert.equal(cfg.getRegister(reg.id)?.decimalPlaces, decimalPlaces)
  }
  for (const decimalPlaces of [-1, 9, 1.5, '2', NaN, undefined]) {
    assert.throws(() => cfg.updateRegister(reg.id, { decimalPlaces }))
    assert.equal(cfg.getRegister(reg.id)?.decimalPlaces, null)
  }
  cfg.updateRegister(reg.id, { decimalPlaces: 2 })
  ;(cfg as any).db.close()
  cfg = new ConfigStore({ dbPath: path })
  assert.equal(cfg.getRegister(reg.id)?.decimalPlaces, 2)
  console.log('DISPLAY CONFIG OK: legacy migration, range validation and persistence')
} finally {
  ;(cfg as any).db.close()
  rmSync(dir, { recursive: true, force: true })
}
