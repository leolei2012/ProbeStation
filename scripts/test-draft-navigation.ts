import assert from 'node:assert/strict'
import { DraftNavigation } from '../apps/web/src/draft-navigation.ts'
import { draftEditor, draftSurface, assertDraftWiring } from './fixtures/draft-navigation-driver.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('DRAFT NAVIGATION OK: ' + name) }
await check('owner/range/latest getters, aggregate once and cleanup are scoped without storing draft fields', () => {
  assertDraftWiring(draftSurface())
  const drafts = new DraftNavigation(), one = drafts.scope(1), two = drafts.scope(2)
  let dirty = false, busy = false, prompts = 0, blocks = 0
  const live = one.register('live', () => ({ dirty, busy })), device = one.register('device', () => ({ dirty: true, busy: false })), foreign = two.register('live', () => { throw Error('must not read unrelated owner') })
  const ask = () => { prompts++; return false }, blocked = () => { blocks++ }
  assert(drafts.allow(1, 'live', ask, blocked)); assert.equal(prompts, 0)
  dirty = true; assert(!drafts.allow(1, 'all', ask, blocked)); assert.equal(prompts, 1, 'two dirty editors get one question')
  busy = true; assert(!drafts.allow(1, 'live', ask, blocked)); assert.equal(prompts, 1); assert.equal(blocks, 1)
  live(); live(); assert(drafts.allow(1, 'live', ask, blocked)); assert.equal(prompts, 1)
  device(); assert(drafts.allow(1, 'all', ask, blocked)); assert(drafts.allow(null, 'all', ask, blocked))
  const unknown = one.register('live', () => { throw Error('unavailable') })
  assert(!drafts.allow(1, 'live', ask, blocked)); assert.equal(blocks, 2); unknown(); foreign()
  const first = one.register('live', () => ({ dirty: true, busy: false })), second = one.register('live', () => ({ dirty: true, busy: false }))
  first(); first(); assert(!drafts.allow(1, 'all', ask, blocked)); assert.equal(prompts, 2); second()
})
await check('device/global/reference cancellation has zero navigation effects; explicit retry asks once then discards without saving', () => {
  for (const kind of ['point', 'device'] as const) for (const path of ['device', 'database', 'reference'] as const) {
    const page = draftSurface({ mobile: true }), modal = draftEditor(kind, page.registration())
    try {
      modal.change(); const before = page.state()
      const go = () => path === 'device' ? page.select(2) : path === 'database' ? page.global('database') : page.reference()
      go(); assert.deepEqual(page.state(), before); assert.equal(page.changes.length, 0); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT'); assert.equal(page.prompts.length, 1)
      page.setAnswer(true); go(); assert.notDeepEqual(page.state(), before); assert.equal(page.prompts.length, 2, 'a new explicit request rechecks consent')
      assert.equal(modal.calls.close, 0); assert.equal(modal.calls.save, 0); modal.driver.dispose()
      page.select(1); assert.equal(page.prompts.length, 2, 'unregistered editor cannot block later navigation')
    } finally { modal.driver.dispose() }
  }
})
await check('clean/reverted editors and same-device/same-page/live links never ask', () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration())
    try {
      modal.change(); page.select(1); page.global('monitor'); page.reference(1, 'live'); page.localTab(0)
      assert.equal(page.prompts.length, 0); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT')
      modal.change(modal.original); page.select(2); assert.equal(page.prompts.length, 0)
    } finally { modal.driver.dispose() }
  }
})
await check('same-device references protect only live drafts; target effect does not ask again', () => {
  const page = draftSurface(), point = draftEditor('point', page.registration()), device = draftEditor('device', page.registration())
  try {
    point.change(); device.change(); const before = page.state(); page.reference(1)
    assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1)
    page.setAnswer(true); page.reference(1); const prompts = page.prompts.length; page.applyTarget()
    assert.equal(page.state().tab, 2); assert.equal(page.prompts.length, prompts); assert.equal(device.value(), 'UNSAVED MOCK DRAFT')
    point.driver.dispose(); page.reference(1, 'diagnostics'); page.applyTarget(); assert.equal(page.prompts.length, prompts); assert.equal(page.state().tab, 3)
  } finally { point.driver.dispose(); device.driver.dispose() }
  const slave = draftSurface({ slave: true }), live = draftEditor('point', slave.registration())
  try { live.change(); slave.reference(1, 'diagnostics'); slave.applyTarget(); assert.equal(slave.state().tab, 0); assert.equal(slave.prompts.length, 0) } finally { live.driver.dispose() }
})
await check('local tab cancellation keeps tab/history intent; device draft is unrelated to that unmount', () => {
  const page = draftSurface(), point = draftEditor('point', page.registration()), device = draftEditor('device', page.registration())
  try {
    point.change(); device.change(); const before = page.state(); page.localTab(5)
    assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1)
    page.setAnswer(true); page.localTab(5); assert.equal(page.state().tab, 5); assert.equal(page.state().cancelledHistory, 1); assert.equal(page.prompts.length, 2)
    point.driver.dispose(); page.localTab(0); page.localTab(2); assert.equal(page.prompts.length, 2); assert.equal(device.value(), 'UNSAVED MOCK DRAFT')
  } finally { point.driver.dispose(); device.driver.dispose() }
})
await check('saving locks block only affected unmounts even before state render and never abort/retry writes', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface({ english: true }), pending = deferred(), modal = draftEditor(kind, page.registration(), () => pending.promise)
    try {
      modal.change(); modal.submit(false); assert.equal(modal.calls.save, 1)
      const before = page.state(); page.setAnswer(true); page.select(2); page.global('database')
      assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 0); assert.equal(page.notices.length, 2)
      page.reference(1)
      assert.equal(page.state().token, kind === 'point' ? 0 : 1, 'device editor stays mounted for same-device history')
      assert.equal(modal.calls.save, 1); assert.equal(modal.calls.close, 0)
      pending.reject(Error('synthetic unknown outcome')); await tick(); modal.driver.render()
      const prompts = page.prompts.length; page.setAnswer(false); page.select(2); assert.equal(page.prompts.length, prompts + 1); assert.equal(modal.calls.save, 1)
    } finally { pending.resolve(); await tick(); modal.driver.dispose() }
  }
})
await check('successful own close/discard unregisters and successful save is not mistaken for leaving a dirty draft', async () => {
  const page = draftSurface(), point = draftEditor('point', page.registration())
  try {
    point.change(); point.close(); point.resume(); assert.equal(point.value(), 'UNSAVED MOCK DRAFT')
    point.close(); point.discard(); assert.equal(point.calls.close, 1); page.select(2); assert.equal(page.prompts.length, 0); assert.equal(point.calls.save, 0)
  } finally { point.driver.dispose() }
  const devicePage = draftSurface(), pending = deferred(); let editor!: ReturnType<typeof draftEditor>, closed = 0, saved = 0
  const save = devicePage.deviceSaveHandler(async (_id: number, _fields: unknown, expected: { id: number }) => { saved++; assert.equal(expected.id, 1); await pending.promise }, () => { closed++; editor.driver.dispose() })
  editor = draftEditor('device', devicePage.registration(), save)
  try {
    editor.change(); editor.submit(); devicePage.select(2); assert.equal(devicePage.state().selectedId, 1); assert.equal(devicePage.prompts.length, 0)
    pending.resolve(); await tick(); assert.equal(closed, 1); assert.equal(saved, 1)
    devicePage.select(2); assert.equal(devicePage.state().selectedId, 2); assert.equal(devicePage.prompts.length, 0)
  } finally { pending.resolve(); await tick(); editor.driver.dispose() }
})
await check('multiple editors prompt once, cancelled consent is not cached, dialogs are bilingual and fail safely', () => {
  for (const english of [false, true]) {
    const page = draftSurface({ english }), one = draftEditor('point', page.registration()), two = draftEditor('device', page.registration())
    try {
      one.change(); two.change(); page.select(2); assert.equal(page.prompts.length, 1); assert(page.prompts[0].includes(english ? 'Cancel keeps editing' : '选择取消可继续编辑'))
      page.select(2); assert.equal(page.prompts.length, 2); assert.equal(page.state().selectedId, 1)
      page.setAnswer(Error('dialog unavailable')); page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(page.notices.length, 1)
    } finally { one.driver.dispose(); two.driver.dispose() }
  }
})
await check('already missing device view ignores delayed registrations without pretending to recover lost drafts', () => {
  const page = draftSurface(), old = draftEditor('point', page.registration())
  try {
    old.change(); page.remove(); assert.equal(page.render().type, 'mock-empty-view')
    // Model a cleanup that has not run yet; there is no longer a DeviceView to unload.
    page.select(2); assert.equal(page.state().selectedId, 2); assert.equal(page.prompts.length, 0)
  } finally { old.driver.dispose() }
})
console.log('DRAFT NAVIGATION TEST OK: ' + passed + ' scoped registry/actual callback/editor groups; mock-only, no browser or data writes; detached records tested separately')
