import assert from 'node:assert/strict'
import { parsePointSettingsDraft, type PointSettingsDraft } from '../apps/web/src/point-settings.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PointSettingsEditor } from '../apps/web/src/PointSettingsEditor.tsx'
import { ConfigStore } from '../packages/config/src/index.ts'
import { curveValue, physicalValue } from '../apps/web/src/physical-value.ts'

const draft: PointSettingsDraft = { dataType: 'uint16', unit: ' ℃ ', factor: '0', offset: '12.5', decimalPlaces: '1', rows: [] }
const t = (key: string) => key
assert.equal(parsePointSettingsDraft(draft, 'uint16', 1, t).factor, 0, 'a valid zero-factor point must remain editable')
assert.deepEqual(parsePointSettingsDraft(draft, 'uint16', 1, t), { dataType: 'uint16', unit: '℃', factor: 0, offset: 12.5, decimalPlaces: 1, enumJson: null })
for (const factor of ['0', '0.0', '0e3', ' -0 ', '-2', '.1', '1e-3']) assert.ok(Number.isFinite(parsePointSettingsDraft({ ...draft, factor }, 'uint16', 1, t).factor))
for (const field of ['factor', 'offset'] as const) for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e999', '12bad']) {
  assert.throws(() => parsePointSettingsDraft({ ...draft, [field]: value }, 'uint16', 1, t), /pointInvalidScale/)
}
assert.throws(() => parsePointSettingsDraft({ ...draft, dataType: 'uint32' }, 'uint16', 1, t), /valueShort/)
assert.equal(parsePointSettingsDraft({ ...draft, dataType: 'uint32' }, 'uint16', 2, t).dataType, 'uint32')
assert.equal(parsePointSettingsDraft({ ...draft, dataType: 'uint32' }, 'uint32', 1, t).dataType, 'uint32', 'existing metadata edit retains the prior width compatibility rule')
const rows = [{ value: ' 0001 ', label: ' On ' }, { value: '-2', label: ' Off ' }]
assert.deepEqual(JSON.parse(parsePointSettingsDraft({ ...draft, rows }, 'uint16', 1, t).enumJson!), { '1': 'On', '-2': 'Off' })
assert.throws(() => parsePointSettingsDraft({ ...draft, rows: [...rows, { value: '1', label: 'duplicate' }] }, 'uint16', 1, t), /enumDuplicate/)
assert.throws(() => parsePointSettingsDraft({ ...draft, rows: [{ value: '0.1', label: 'bad' }] }, 'uint16', 1, t), /enumInvalidValue/)
assert.throws(() => parsePointSettingsDraft({ ...draft, rows: [{ value: '1', label: ' ' }] }, 'uint16', 1, t), /enumEmptyLabel/)
assert.equal(parsePointSettingsDraft({ ...draft, unit: ' ', decimalPlaces: '' }, 'uint16', 1, t).unit, null)
const before = JSON.stringify({ draft, rows })
const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  const device = cfg.createObject('mock edit', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'mock', 3, 0, 2)
  const point = cfg.createRegister(group.id, device.id, 'zero scale', 3, 0, 'uint32')
  cfg.updateRegister(point.id, { factor: 0, offset: 12.5, unit: 'old', decimalPlaces: 1 })
  const saved = cfg.getRegister(point.id)!
  const next = parsePointSettingsDraft({ ...draft, dataType: saved.dataType, factor: String(saved.factor), offset: String(saved.offset), unit: 'new' }, saved.dataType, 2, t)
  cfg.updateRegister(point.id, next)
  const result = cfg.getRegister(point.id)!
  assert.equal(result.factor, 0); assert.equal(result.unit, 'new'); assert.equal(result.dataType, 'uint32')
  assert.equal(result.startAddress, 0); assert.equal(cfg.getGroup(group.id)!.quantity, 2)
  assert.equal(physicalValue(65536, result).value, '12.5'); assert.equal(curveValue(65536, result, 'physical'), 12.5)
  assert.equal(curveValue(65536, result, 'raw'), 65536); assert.equal(curveValue(null, result, 'physical'), null, 'zero scale cannot turn missing samples into valid values')
  assert.equal(physicalValue(NaN, result).issue, 'invalid')
  const snapshot = JSON.stringify(cfg.getRegister(point.id))
  assert.throws(() => cfg.updateRegister(point.id, parsePointSettingsDraft({ ...draft, factor: '' }, 'uint32', 2, t)))
  assert.equal(JSON.stringify(cfg.getRegister(point.id)), snapshot, 'invalid draft is rejected before any configuration update')
} finally { (cfg as any).db.close() }
assert.equal(JSON.stringify({ draft, rows }), before)
let saves = 0
const render = (dataType: string, factor: number) => renderToStaticMarkup(createElement(PointSettingsEditor, {
  name: '模拟点位', address: 0, settings: { dataType, factor, offset: 12.5, unit: '℃', enumJson: null }, available: 4,
  typeGroups: [{ key: 'types', types: [dataType] }], t, onClose() {}, async onSave() { saves++ },
}))
assert.match(render('uint32', 0), /pointZeroFactorHint/)
assert.doesNotMatch(render('uint32', 1), /pointZeroFactorHint/)
for (const raw of ['hex32', 'bin32']) assert.doesNotMatch(render(raw, 0), /pointZeroFactorHint/, 'raw formats do not claim physical conversion')
assert.equal(saves, 0, 'rendering has no write side effects')
console.log('POINT SETTINGS OK: zero-scale edit/persistence, invalid-input isolation, retained width/enumeration validation, raw/physical/missing data, immutable drafts and SSR hint visibility; memory-only, no DOM automation')
