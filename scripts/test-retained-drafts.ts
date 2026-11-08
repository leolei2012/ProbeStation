import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DraftNavigation } from '../apps/web/src/draft-navigation.ts'
import { RetainedDraftNotice } from '../apps/web/src/RetainedDraftNotice.tsx'
import { PointEnumEditor } from '../apps/web/src/PointEnumEditor.tsx'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('RETAINED DRAFT OK: ' + name) }
await check('accepted device removal captures actual dirty editors before unmount, without saving or prompting', () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration())
    try {
      modal.change('RAW UNSAVED <synthetic>'); page.remove(); modal.driver.dispose()
      const records = page.drafts.retained()
      assert.equal(records.length, 1, 'background removal must retain one read-only draft before editor disposal')
      assert.equal(records[0].ownerId, 1); assert.equal(records[0].kind, kind === 'point' ? 'live' : 'device')
      assert(records[0].snapshot!.text.includes('RAW UNSAVED <synthetic>')); assert.equal(records[0].busy, false)
      assert.equal(page.render().type, 'mock-empty-view'); assert.equal(modal.calls.save, 0); assert.equal(modal.calls.close, 0); assert.equal(page.prompts.length, 0)
    } finally { modal.driver.dispose() }
  }
})
await check('unrelated refresh, clean/reverted and explicitly discarded editors do not retain; active cancellation still edits', () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration())
    try {
      modal.change(); page.drafts.retainMissing([1]); assert.equal(page.drafts.retained().length, 0)
      page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT')
      modal.change(modal.original); page.remove(); assert.equal(page.drafts.retained().length, 0)
    } finally { modal.driver.dispose() }
    const discarded = draftSurface(), old = draftEditor(kind, discarded.registration())
    try { old.change(); old.close(); old.discard(); discarded.remove(); assert.equal(discarded.drafts.retained().length, 0) } finally { old.driver.dispose() }
  }
})
await check('retention is immutable and deduplicated per mounted editor, never reattaches to reused device IDs', () => {
  const drafts = new DraftNavigation(); let text = 'original raw input', captures = 0
  const scope = drafts.scope(1), off = scope.register('live', () => ({ dirty: true, busy: false }), () => { captures++; return { context: 'opening source, not verified identity', text } })
  drafts.retainMissing([]); const first = drafts.retained()[0]; text = 'later'; drafts.retainMissing([]); off()
  assert.equal(captures, 1); assert.equal(first.snapshot?.text, 'original raw input'); assert(Object.isFrozen(first)); assert(Object.isFrozen(first.snapshot))
  drafts.retainMissing([1]); assert.equal(drafts.retained()[0], first)
  const fresh = scope.register('device', () => ({ dirty: true, busy: false }), () => ({ context: 'same ID, new local editor', text: 'separate' }))
  drafts.retainMissing([]); fresh(); assert.equal(drafts.retained().length, 2); assert.notEqual(drafts.retained()[1].id, first.id)
  drafts.discardRetained(first.id); assert.equal(drafts.retained().length, 1); drafts.discardRetained(first.id); assert.equal(drafts.retained().length, 1)
  assert.equal(new DraftNavigation().retained().length, 0, 'new page/controller does not recover old memory')
})
await check('busy capture records unknown outcome; late completion cannot clear or rewrite detached records', async () => {
  for (const kind of ['point', 'device'] as const) for (const reject of [false, true]) {
    let complete!: () => void, fail!: (e: Error) => void
    const wait = new Promise<void>((resolve, no) => { complete = resolve; fail = no })
    const page = draftSurface(), modal = draftEditor(kind, page.registration(), () => wait)
    try {
      modal.change('PENDING RAW'); modal.submit(false); page.remove(); modal.driver.dispose()
      const first = page.drafts.retained()[0]; assert.equal(first.busy, true); assert(first.snapshot?.text.includes('PENDING RAW'))
      if (reject) fail(Error('mock uncertain outcome')); else complete(); await tick()
      assert.equal(page.drafts.retained()[0], first); assert.equal(modal.calls.save, 1)
    } finally { complete(); await tick(); modal.driver.dispose() }
  }
})
await check('getter/capture failures retain an explicit unavailable record without blocking accepted configuration', () => {
  for (const failure of ['status', 'snapshot', 'invalid', 'missing'] as const) {
    const drafts = new DraftNavigation()
    drafts.scope(1).register('live', () => { if (failure === 'status') throw Error('private synthetic detail'); return { dirty: true, busy: false } }, failure === 'missing' ? undefined : () => { if (failure === 'snapshot') throw Error('private synthetic detail'); return failure === 'invalid' ? { context: 1, text: {} } as any : { context: 'opening', text: 'input' } })
    assert.doesNotThrow(() => drafts.retainMissing([])); const record = drafts.retained()[0]
    assert.equal(record.snapshot, null); assert(!JSON.stringify(record).includes('private synthetic detail'))
  }
})
await check('observed removal revokes the old editor even if same-ID reappearance is batched before unmount', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration())
    try {
      modal.change('OLD EDITOR INPUT'); page.remove()
      modal.submit(false); assert.equal(modal.calls.save, 0, 'revocation is synchronous before any rerender')
      // No dispose: model both list publications reaching React before a keyed child unmount commits.
      await page.refresh(async () => [{ id: 1, name: 'replacement with same ID' }]); modal.driver.render()
      modal.submit(); await tick(); assert.equal(modal.calls.save, 0, 'retained old editor must not save to a same-ID replacement')
      assert.equal(modal.driver.one('button', props => props.type === 'submit').props.disabled, true)
      assert.equal(modal.driver.one('fieldset').props.disabled, true)
      assert.equal(modal.calls.close, 0); assert.equal(page.drafts.retained().length, 1)
    } finally { modal.driver.dispose() }
  }
})
await check('actual raw fields and opaque/edited enum text are retained without numeric normalization', () => {
  for (const original of [null, '{opaque invalid', '{"0":"off"}']) {
    const page = draftSurface(), modal = draftEditor('point', page.registration(), undefined, original)
    try {
      modal.driver.one('input', props => props['aria-label'] === 'pointFactor').props.onChange({ target: { value: '' } }); modal.driver.render()
      if (original?.includes('off')) { modal.driver.one(PointEnumEditor).props.onAction({ type: 'update', id: 0, field: 'label', text: ' invalid <&> label ' }); modal.driver.render() }
      modal.change(' Ω '); page.remove()
      const payload = JSON.parse(page.drafts.retained()[0].snapshot!.text)
      assert.equal(payload.fields.factor, ''); assert.equal(payload.fields.unit, ' Ω '); assert.equal(payload.opening.unit, 'V'); assert.equal(payload.enums.original, original)
      if (original?.includes('off')) { assert.equal(payload.enums.rows[0].label, ' invalid <&> label '); assert.equal(payload.enums.intent, 'edit') }
    } finally { modal.driver.dispose() }
  }
})
await check('only the latest valid accepted list retains: failed, malformed, cancelled and stale reads cannot detach', async () => {
  const page = draftSurface(), modal = draftEditor('device', page.registration())
  const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(yes => { resolve = yes }); return { promise, resolve } }
  try {
    modal.change()
    await page.refresh(async () => { throw Error('mock read failure') }); assert.equal(page.drafts.retained().length, 0)
    await page.refresh(async () => ({})); await page.refresh(async () => [{ id: 0 }]); assert.equal(page.drafts.retained().length, 0)
    const old = deferred(), pending = page.refresh(() => old.promise)
    await page.refresh(async () => [{ id: 1 }]); old.resolve([]); await pending; assert.equal(page.drafts.retained().length, 0)
    const cancelled = deferred(), closed = page.refresh(() => cancelled.promise); page.cancelRefresh(); cancelled.resolve([]); await closed; assert.equal(page.drafts.retained().length, 0)
    await page.refresh(async () => []); assert.equal(page.drafts.retained().length, 1)
    modal.driver.dispose(); await page.refresh(async () => [{ id: 1, name: 'same ID replacement' }]); page.select(1)
    const fresh = draftEditor('device', page.registration())
    try { assert.equal(fresh.value(), fresh.original); assert.equal(fresh.calls.save, 0); assert.equal(page.retentionNotice().props.records.length, 1) } finally { fresh.driver.dispose() }
  } finally { modal.driver.dispose() }
})
await check('actual root notice is read-only and escaped, bilingual, page-global and discards only after explicit confirmation', () => {
  for (const english of [false, true]) {
    const page = draftSurface({ english }), modal = draftEditor('point', page.registration())
    try {
      modal.change('<script>synthetic</script>'); page.remove(); modal.driver.dispose(); page.select(2); page.global('database')
      const notice = page.retentionNotice(), props = notice.props
      assert.equal(props.records.length, 1); assert.equal(props.english, english)
      const html = renderToStaticMarkup(React.createElement(RetainedDraftNotice, props))
      assert(html.includes(english ? 'page memory only' : '当前页内存')); assert(html.includes(english ? 'same ID' : '同 ID'))
      assert(html.includes('&lt;script&gt;synthetic&lt;/script&gt;')); assert(!html.includes('<script>')); assert(!html.includes('<form')); assert(!html.includes('type="submit"'))
      props.onDiscard(props.records[0].id); assert.equal(page.retentionNotice().props.records.length, 1, 'cancel preserves record')
      assert.equal(page.prompts.length, 1); page.setAnswer(Error('mock confirmation unavailable')); props.onDiscard(props.records[0].id); assert.equal(page.retentionNotice().props.records.length, 1)
      page.setAnswer(true); props.onDiscard(props.records[0].id)
      assert.equal(page.retentionNotice().props.records.length, 0); assert.equal(modal.calls.save, 0)
      assert.equal(renderToStaticMarkup(React.createElement(RetainedDraftNotice, { records: [], english, onDiscard() { throw Error('must not run') } })), '')
    } finally { modal.driver.dispose() }
    const unavailable = renderToStaticMarkup(React.createElement(RetainedDraftNotice, { records: [{ id: 1, ownerId: 1, kind: 'device', busy: null, snapshot: null }], english, onDiscard() {} }))
    assert(unavailable.includes(english ? 'Input capture failed' : '输入留存失败')); assert(unavailable.includes(english ? 'original request was not cancelled' : '原请求未取消'))
  }
})
console.log('RETAINED DRAFT TEST OK: ' + passed + ' actual-source/mock groups; no save/restore/persistence or device identity claim')
