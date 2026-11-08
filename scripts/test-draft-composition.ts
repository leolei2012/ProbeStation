import assert from 'node:assert/strict'
import { draftEditor, draftSurface, syntheticDevice } from './fixtures/draft-navigation-driver.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const devices = () => [{ ...syntheticDevice }, { ...syntheticDevice, id: 2, name: 'synthetic B' }]
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('DRAFT COMPOSITION OK: ' + name) }
await check('missing then same-ID reappearance seals both dirty and clean editors before unmount commits', async () => {
  for (const dirtyKind of ['point', 'device'] as const) {
    const page = draftSurface(), dirty = draftEditor(dirtyKind, page.registration()), clean = draftEditor(dirtyKind === 'point' ? 'device' : 'point', page.registration())
    try {
      dirty.change('FIRST DIRTY'); page.remove(); await page.refresh(async () => devices())
      // Keep the old keyed components alive to model coalesced missing/reappearance publications.
      clean.change('EDIT AFTER REAPPEARANCE'); clean.submit(false); dirty.submit(false)
      assert.equal(clean.calls.save, 0, 'even a previously clean old editor must not save after observed device removal')
      assert.equal(dirty.calls.save, 0); assert.equal(page.drafts.retained().length, 1); assert(page.drafts.retained()[0].snapshot!.text.includes('FIRST DIRTY'))
    } finally { await tick(); dirty.driver.dispose(); clean.driver.dispose() }
  }
})
await check('multiple drafts, pending save, unknown result and cancelled navigation preserve inputs without retry', async () => {
  for (const savingKind of ['point', 'device'] as const) {
    const page = draftSurface(), wait = deferred(), saving = draftEditor(savingKind, page.registration(), () => wait.promise), other = draftEditor(savingKind === 'point' ? 'device' : 'point', page.registration())
    try {
      saving.change('UNKNOWN SAVE INPUT'); other.change('OTHER INPUT'); saving.submit(false)
      const before = page.state(); page.select(2); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 0)
      wait.reject(Error('synthetic unknown result')); await tick(); saving.driver.render()
      page.reference(2); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1)
      assert.equal(saving.value(), 'UNKNOWN SAVE INPUT'); assert.equal(other.value(), 'OTHER INPUT'); assert.equal(saving.calls.save, 1); assert.equal(other.calls.save, 0)
      assert(saving.window.fire().prevented); assert(other.window.fire().prevented)
      page.setAnswer(true); page.global('database'); assert.equal(page.state().view, 'database'); assert.equal(page.prompts.length, 2)
      saving.driver.dispose(); other.driver.dispose(); assert.equal(saving.window.count(), 0); assert.equal(other.window.count(), 0); assert.equal(page.drafts.retained().length, 0)
    } finally { wait.resolve(); await tick(); saving.driver.dispose(); other.driver.dispose() }
  }
})
await check('two retained records outlive unknown save completion; partial discard and cancellation keep native risk', async () => {
  const page = draftSurface(), wait = deferred(), point = draftEditor('point', page.registration(), () => wait.promise), device = draftEditor('device', page.registration())
  let release: undefined | (() => void)
  try {
    point.change('PENDING POINT'); device.change('UNSAVED DEVICE'); point.submit(false); page.remove()
    const records = page.drafts.retained(), frozen = JSON.stringify(records); assert.equal(records.length, 2); assert.equal(records.find(record => record.kind === 'live')!.busy, true)
    point.driver.dispose(); device.driver.dispose(); release = page.mountUnload(); assert(page.window.fire().prevented)
    await page.refresh(async () => devices()); wait.reject(Error('synthetic late unknown')); await tick(); assert.equal(JSON.stringify(page.drafts.retained()), frozen)
    const first = records[0].id; page.setAnswer(false); page.retentionNotice().props.onDiscard(first); assert.equal(page.drafts.retained().length, 2)
    page.setAnswer(true); page.retentionNotice().props.onDiscard(first); assert.equal(page.drafts.retained().length, 1); assert(page.window.fire().prevented)
    page.retentionNotice().props.onDiscard(records[1].id); assert.equal(page.drafts.retained().length, 0); assert.equal(page.window.fire().prevented, 0)
    assert.equal(point.calls.save, 1); assert.equal(device.calls.save, 0)
  } finally { wait.resolve(); await tick(); release?.(); point.driver.dispose(); device.driver.dispose() }
})
await check('discarding an old record never reactivates old editors or changes a new same-ID draft', async () => {
  const page = draftSurface(), old = draftEditor('device', page.registration()); let fresh: ReturnType<typeof draftEditor> | undefined
  let release: undefined | (() => void)
  try {
    old.change('OLD RECORD'); page.remove(); const id = page.drafts.retained()[0].id
    await page.refresh(async () => devices()); fresh = draftEditor('point', page.registration(), undefined, null, page.window); fresh.change('NEW DRAFT')
    release = page.mountUnload(); page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(page.prompts.length, 1)
    page.setAnswer(true); page.retentionNotice().props.onDiscard(id); assert.equal(page.drafts.retained().length, 0)
    assert(page.window.fire().prevented, 'new draft remains risky after the last old record is discarded')
    old.submit(); assert.equal(old.calls.save, 0); assert.equal(fresh.value(), 'NEW DRAFT'); assert.equal(fresh.calls.save, 0)
    fresh.change(fresh.original); assert.equal(page.window.fire().prevented, 0)
  } finally { await tick(); release?.(); old.driver.dispose(); fresh?.driver.dispose() }
})
await check('clean editors are sealed without records or false prompts, while unrelated owners remain usable', async () => {
  const page = draftSurface(), clean = draftEditor('device', page.registration()), foreign = draftEditor('point', page.drafts.scope(2))
  let release: undefined | (() => void)
  try {
    await page.refresh(async () => [{ ...syntheticDevice, id: 2 }]); release = page.mountUnload(); assert.equal(page.drafts.retained().length, 0); assert.equal(page.window.count(), 0)
    await page.refresh(async () => devices()); clean.submit(false); assert.equal(clean.calls.save, 0)
    foreign.change('FOREIGN INPUT'); foreign.submit(); await tick(); assert.equal(foreign.calls.save, 1)
    const legacy = draftSurface().drafts, unregister = legacy.scope(3).register('live', () => ({ dirty: false, busy: false }))
    legacy.retainMissing([1, 2]); assert.equal(legacy.retained().length, 0, 'legacy clean registration without capture must not invent an unavailable draft'); unregister()
  } finally { release?.(); clean.driver.dispose(); foreign.driver.dispose() }
})
console.log('DRAFT COMPOSITION TEST OK: ' + passed + ' actual callback/editor/mock-event groups; no native browser dialog, real data, hardware or source-generation claim')
