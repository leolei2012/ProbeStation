import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard } from '../apps/web/src/point-draft-close.ts'
import { createPointEnumDraft, updatePointEnumDraft } from '../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsUpdate } from '../apps/web/src/point-settings.ts'
import { PointSettingsEditor } from '../apps/web/src/PointSettingsEditor.tsx'
import { PointDraftDiscard } from '../apps/web/src/PointDraftDiscard.tsx'
import { ConfigStore } from '../packages/config/src/index.ts'

const settings = { dataType: 'uint16', unit: null, factor: 0, offset: -2.5, enumJson: ' { "01": " On " } ', decimalPlaces: null }, opening = pointDraftFields(settings), enums = createPointEnumDraft(settings.enumJson)
assert(Object.isFrozen(opening)); assert.equal(opening.factor, '0'); assert.equal(opening.unit, ''); assert.equal(opening.decimalPlaces, '')
assert(!pointDraftChanged(opening, { ...opening }, enums))
for (const field of Object.keys(opening)) {
  const edited = { ...opening, [field]: opening[field as keyof typeof opening] + 'x' }
  assert(pointDraftChanged(opening, edited, enums), field + ' edit must be retained even if invalid')
  assert(!pointDraftChanged(opening, { ...edited, [field]: opening[field as keyof typeof opening] }, enums), 'full text revert is clean')
}
assert(pointDraftChanged(opening, { ...opening, factor: '0.0' }, enums), 'conservative input-text change is dirty even with same numeric value')
const concurrent = { ...settings, unit: 'server refresh' }; assert.equal(opening.unit, ''); assert(pointDraftChanged(opening, pointDraftFields(concurrent), enums), 'new server props do not redefine the opening input baseline')
for (const source of [null, '', '{broken', '[]', '{}', settings.enumJson]) {
  let state = createPointEnumDraft(source)
  assert(!pointDraftChanged(opening, opening, state), 'opening opaque source is clean without parsing/replacing it')
  state = updatePointEnumDraft(state, { type: 'clear' }); assert.equal(pointDraftChanged(opening, opening, state), source !== null)
  state = updatePointEnumDraft(state, { type: 'restore' }); assert(!pointDraftChanged(opening, opening, state))
}
const large = createPointEnumDraft(JSON.stringify(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [i, 'label ' + i]))))
const tail = updatePointEnumDraft(large, { type: 'update', id: large.rows[9999].id, field: 'label', text: 'unsaved tail' })
assert(pointDraftChanged(opening, opening, tail)); assert(!pointDraftChanged(opening, opening, updatePointEnumDraft(tail, { type: 'restore' })))
const added = updatePointEnumDraft(enums, { type: 'add' })
assert(pointDraftChanged(opening, opening, added)); assert(!pointDraftChanged(opening, opening, updatePointEnumDraft(added, { type: 'remove', id: added.rows.at(-1)!.id })))

const clean = new PointDraftCloseGuard(); assert.equal(clean.discard(false), 'none'); assert.equal(clean.resume(false), 'none'); assert.equal(clean.request(false, false), 'close'); assert.equal(clean.request(false, false), 'none'); assert.equal(clean.saved(), 'none'); assert(!clean.canSave)
const guard = new PointDraftCloseGuard()
assert.equal(guard.request(true, true), 'none'); assert(guard.canSave); assert(!guard.confirming)
assert.equal(guard.request(true, false), 'prompt'); assert(guard.confirming); assert(!guard.canSave)
assert.equal(guard.request(true, false), 'none', 'repeated close does not count as confirmation')
assert.equal(guard.discard(true), 'none'); assert.equal(guard.resume(true), 'none'); assert(guard.confirming)
assert.equal(guard.resume(false), 'resume'); assert(guard.canSave); assert.equal(guard.discard(false), 'none', 'a stale discard click after continuing cannot close')
assert.equal(guard.request(true, false), 'prompt'); assert.equal(guard.discard(false), 'close'); assert.equal(guard.discard(false), 'none'); assert.equal(guard.saved(), 'none')

// Real isolated configuration proves close/resume/discard do not save or undo it.
const config = new ConfigStore({ dbPath: ':memory:' })
try {
  const device = config.createObject('synthetic draft', 'mock.invalid', 502), group = config.createGroup(device.id, 'synthetic', 3, 0, 4), point = config.createRegister(group.id, device.id, 'synthetic', 3, 0, 'uint16')
  config.updateRegister(point.id, settings)
  const before = JSON.stringify(config.getRegister(point.id)), draft = { ...opening, unit: ' unsaved ', factor: '' }, draftEnums = tail, frozen = JSON.stringify({ draft, draftEnums })
  const close = new PointDraftCloseGuard()
  assert.equal(close.request(pointDraftChanged(opening, draft, draftEnums), false), 'prompt')
  assert.equal(close.resume(false), 'resume'); assert.equal(JSON.stringify({ draft, draftEnums }), frozen); assert.equal(JSON.stringify(config.getRegister(point.id)), before)
  assert.throws(() => parsePointSettingsUpdate(draft, draftEnums, 'uint16', 4, key => key), /pointInvalidScale/)
  assert(close.canSave); assert.equal(close.request(true, false), 'prompt'); assert.equal(close.discard(false), 'close'); assert.equal(JSON.stringify(config.getRegister(point.id)), before, 'discard has no backend save or undo')
  // Save failure leaves the guard editing; busy closes never abort the pending work.
  const failed = new PointDraftCloseGuard(); let finish!: () => void, writes = 0, closed = 0, busy = true
  const pending = new Promise<void>(resolve => { finish = resolve }).then(() => { writes++; throw new Error('synthetic unknown write result') })
  assert.equal(failed.request(true, busy), 'none'); assert.equal(failed.discard(busy), 'none'); finish()
  await assert.rejects(pending, /unknown write result/); busy = false
  assert.equal(writes, 1); assert(failed.canSave); assert.equal(failed.request(true, busy), 'prompt'); assert.equal(failed.resume(busy), 'resume'); assert.equal(writes, 1)
  const valid = parsePointSettingsUpdate({ ...opening, unit: ' saved ' }, enums, 'uint16', 4, key => key)
  config.updateRegister(point.id, valid)
  if (failed.saved() === 'close') closed++
  if (failed.saved() === 'close') closed++
  assert.equal(closed, 1, 'successful save bypasses dirty prompt and closes once'); assert.equal(config.getRegister(point.id)!.unit, 'saved'); assert.equal(config.getRegister(point.id)!.factor, 0); assert.equal(config.getRegister(point.id)!.enumJson, settings.enumJson)
} finally { (config as any).db.close() }
let callbacks = 0
for (const english of [false, true]) {
  const html = renderToStaticMarkup(createElement(PointDraftDiscard, { english, busy: false, onResume() { callbacks++ }, onDiscard() { callbacks++ } }))
  assert(html.includes(english ? 'Continue editing' : '继续编辑')); assert(html.includes(english ? 'Discard draft and close' : '放弃草稿并关闭')); assert(html.includes('role="alert"')); assert.equal((html.match(/type="button"/g) ?? []).length, 2); assert(html.includes(english ? 'earlier failed save' : '此前失败保存'))
  const disabled = renderToStaticMarkup(createElement(PointDraftDiscard, { english, busy: true, onResume() {}, onDiscard() {} })); assert.equal((disabled.match(/disabled=""/g) ?? []).length, 2)
}
const html = renderToStaticMarkup(createElement(PointSettingsEditor, { name: '<script>point</script>', address: 0, settings, available: 4, typeGroups: [{ key: 'types', types: ['uint16', 'uint32'] }], t: key => key, onClose() { callbacks++ }, async onSave() { callbacks++ } }))
assert(html.includes('&lt;script&gt;point&lt;/script&gt;')); assert(!html.includes('<script>')); assert(!html.includes('point-draft-discard')); assert.equal(callbacks, 0, 'SSR never closes, saves or accesses DOM focus')
console.log('POINT DRAFT CLOSE OK: every scalar input/revert, invalid and opaque/10000-row enum drafts, stable opening baseline, synchronous close/confirm/resume/busy/save guards, no-save/no-undo memory configuration, failed write continuation, exact saved fields and bilingual SSR; no real data, network, hardware, model or browser automation')
