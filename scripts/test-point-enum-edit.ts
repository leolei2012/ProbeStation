import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PointSettingsEditor } from '../apps/web/src/PointSettingsEditor.tsx'
import { PointEnumEditor } from '../apps/web/src/PointEnumEditor.tsx'
import { createPointEnumDraft, pointEnumChanged, updatePointEnumDraft, type PointEnumDraft } from '../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsDraft, parsePointSettingsUpdate } from '../apps/web/src/point-settings.ts'
import { ConfigStore } from '../packages/config/src/index.ts'

const html = renderToStaticMarkup(createElement(PointSettingsEditor, { name: 'synthetic', address: 0, settings: { dataType: 'uint16', unit: 'old', factor: 1, offset: 0, enumJson: '{broken' }, available: 1, typeGroups: [{ key: 'types', types: ['uint16'] }], t: key => key, onClose() {}, async onSave() {} }))
assert.ok(html.includes('原枚举无法逐行读取'), 'opaque original enum must be distinguished from an empty mapping before a scalar-only save')

const fields = { dataType: 'uint16', unit: ' new ', factor: '0', offset: '12.5', decimalPlaces: '2' }, t = (key: string) => key
const patch = (state: PointEnumDraft) => parsePointSettingsUpdate(fields, state, 'uint16', 1, t)
const edit = (state: PointEnumDraft, index: number, field: 'value' | 'label', text: string) => updatePointEnumDraft(state, { type: 'update', id: state.rows[index].id, field, text })
const sources = [null, '{}', '', '{broken', '[]', 'null', '{"1":123}', '{"1":null}', '{"1":{}}', ' { "01": " On ", "-2": " Off " } ', '{"01":"A","1":"B"}', '{"not-integer":"","__proto__":"literal"}', '{"1":"a","1":"b"}']
for (const original of sources) {
  const state = createPointEnumDraft(original), before = JSON.stringify(state), result = patch(state)
  assert.equal(state.original, original); assert.equal(pointEnumChanged(state), false)
  assert.equal(Object.hasOwn(result, 'enumJson'), false, 'unchanged enum must really be absent, not undefined')
  assert.equal(JSON.stringify(result).includes('enumJson'), false)
  assert.equal(result.unit, 'new'); assert.equal(result.factor, 0)
  assert.equal(JSON.stringify(state), before)
  const restored = updatePointEnumDraft(updatePointEnumDraft(state, { type: 'clear' }), { type: 'restore' })
  assert.equal(Object.hasOwn(patch(restored), 'enumJson'), false)
  assert.equal(patch(updatePointEnumDraft(state, { type: 'clear' })).enumJson, original === null ? undefined : null)
}
assert.equal(createPointEnumDraft(null).source, 'empty')
for (const original of ['', '{bad', '[]', 'false', '{"1":123}']) assert.equal(createPointEnumDraft(original).source, 'opaque')
assert.equal(createPointEnumDraft('{}').source, 'map')
const initial = createPointEnumDraft(' { "01": " On ", "-2": " Off " } '), frozen = JSON.stringify(initial)
assert.equal(initial.rows[0].value, '01'); assert.equal(initial.rows[0].label, ' On ')
assert.equal(updatePointEnumDraft(initial, { type: 'update', id: 999, field: 'value', text: 'x' }), initial)
assert.equal(updatePointEnumDraft(initial, { type: 'remove', id: 999 }), initial)
assert.equal(edit(initial, 0, 'label', ' On '), initial)
const changed = edit(initial, 0, 'label', ' New ')
assert.deepEqual(JSON.parse(patch(changed).enumJson!), { '1': 'New', '-2': 'Off' })
assert.equal(Object.hasOwn(patch(edit(changed, 0, 'label', ' On ')), 'enumJson'), false, 'exact edit undo preserves original text')
const added = updatePointEnumDraft(initial, { type: 'add' })
assert.ok(added.rows.at(-1)!.id > initial.rows.at(-1)!.id)
assert.equal(Object.hasOwn(patch(updatePointEnumDraft(added, { type: 'remove', id: added.rows.at(-1)!.id })), 'enumJson'), false)
const restored = updatePointEnumDraft(added, { type: 'restore' })
assert.ok(updatePointEnumDraft(restored, { type: 'add' }).rows.at(-1)!.id > added.rows.at(-1)!.id, 'IDs never reuse removed draft rows')
assert.equal(JSON.stringify(initial), frozen); assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.rows) && Object.isFrozen(initial.rows[0]))

const opaque = createPointEnumDraft('{broken')
assert.equal(updatePointEnumDraft(opaque, { type: 'add' }), opaque, 'opaque source requires explicit replacement intent')
let replacement = updatePointEnumDraft(opaque, { type: 'replace-opaque' })
assert.equal(replacement.rows.length, 1)
assert.throws(() => patch(replacement), /enumInvalidValue/, 'explicit replacement starts with a required blank row, not an accidental clear')
replacement = edit(edit(replacement, 0, 'value', '0007'), 0, 'label', ' new ')
assert.equal(patch(replacement).enumJson, '{"7":"new"}')
const collisions = edit(createPointEnumDraft('{"1":"B","01":"A"}'), 0, 'label', 'edited')
assert.throws(() => patch(collisions), error => error instanceof Error && error.message === 'enumDuplicate' && 'enumRowIndex' in error && error.enumRowIndex === 1)
assert.throws(() => patch(edit(initial, 0, 'value', '1.5')), error => error instanceof Error && error.message === 'enumInvalidValue' && 'enumRowIndex' in error && error.enumRowIndex === 0)
assert.throws(() => patch(edit(initial, 1, 'label', ' ')), error => error instanceof Error && error.message === 'enumEmptyLabel' && 'enumRowIndex' in error && error.enumRowIndex === 1)
assert.throws(() => parsePointSettingsUpdate({ ...fields, factor: '' }, opaque, 'uint16', 1, t), /pointInvalidScale/)
assert.throws(() => parsePointSettingsUpdate({ ...fields, dataType: 'uint32' }, opaque, 'uint16', 1, t), /valueShort/)
// Existing full-DTO callers retain their old explicit-empty behavior.
assert.equal(parsePointSettingsDraft({ ...fields, rows: [] }, 'uint16', 1, t).enumJson, null)

const large = createPointEnumDraft(JSON.stringify(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [i, 'label ' + i]))))
assert.equal(large.rows.length, 10000)
const largeChanged = edit(large, 9999, 'label', 'tail changed'), largeMap = JSON.parse(patch(largeChanged).enumJson!)
assert.equal(Object.keys(largeMap).length, 10000); assert.equal(largeMap['9999'], 'tail changed'); assert.equal(largeMap['0'], 'label 0')
assert.equal(updatePointEnumDraft(large, { type: 'add' }).rows.length, 10001, 'no invented 200-row storage limit')
assert.throws(() => patch(edit(large, 9999, 'label', '')), error => error instanceof Error && 'enumRowIndex' in error && error.enumRowIndex === 9999)
let callbacks = 0
const renderEnums = (state: PointEnumDraft, english = false, busy = false) => renderToStaticMarkup(createElement(PointEnumEditor, { state, english, busy, onAction() { callbacks++ } }))
const largeHtml = renderEnums(large)
assert.equal((largeHtml.match(/class="enum-row"/g) ?? []).length, 20)
assert.match(largeHtml, /1\/500/); assert.match(largeHtml, /10000/)
assert.match(renderEnums(initial), /本次打开时的原枚举文本/)
assert.match(renderEnums(opaque), /用新映射替换原文/)
assert.match(renderEnums(opaque, true), /cannot be read as rows/)
assert.match(renderEnums(opaque, true, true), /disabled=""/)
assert.match(renderEnums(createPointEnumDraft('{"1":"<script>unsafe</script>"}')), /&lt;script&gt;/)
assert.doesNotMatch(renderEnums(createPointEnumDraft('{"1":"<script>unsafe</script>"}')), /<script>/)
assert.equal(callbacks, 0, 'SSR never saves or changes drafts')

const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  const device = cfg.createObject('synthetic enum test', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'synthetic', 3, 0, 1)
  const point = cfg.createRegister(group.id, device.id, 'enum', 3, 0, 'uint16')
  for (const original of sources) {
    cfg.updateRegister(point.id, { enumJson: original })
    cfg.updateRegister(point.id, patch(createPointEnumDraft(original)))
    assert.equal(cfg.getRegister(point.id)!.enumJson, original, 'actual partial-update contract preserves every untouched original')
    assert.equal(cfg.getRegister(point.id)!.factor, 0)
  }
  cfg.updateRegister(point.id, { enumJson: '{"1":"opened"}' })
  const opened = createPointEnumDraft(cfg.getRegister(point.id)!.enumJson)
  cfg.updateRegister(point.id, { enumJson: '{"2":"concurrent"}' })
  cfg.updateRegister(point.id, patch(opened))
  assert.equal(cfg.getRegister(point.id)!.enumJson, '{"2":"concurrent"}', 'omission preserves latest server enum rather than restoring an old snapshot')
  cfg.updateRegister(point.id, patch(replacement)); assert.equal(cfg.getRegister(point.id)!.enumJson, '{"7":"new"}')
  const before = JSON.stringify(cfg.getRegister(point.id))
  assert.throws(() => cfg.updateRegister(point.id, patch(collisions)), /enumDuplicate/)
  assert.equal(JSON.stringify(cfg.getRegister(point.id)), before, 'invalid edited enum must block all fields before writing')
  cfg.updateRegister(point.id, patch(updatePointEnumDraft(opened, { type: 'clear' })))
  assert.equal(cfg.getRegister(point.id)!.enumJson, null)
} finally { (cfg as any).db.close() }
console.log('POINT ENUM EDIT OK: original/opaque text preservation, omitted partial updates and concurrent enum retention, explicit replace/clear/revert, existing validation with row location, 10000-row no-truncation/page SSR, escaping and memory-only persistence; no DOM automation')
