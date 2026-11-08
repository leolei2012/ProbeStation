import assert from 'node:assert/strict'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'

if (process.argv.slice(2).join(' ') !== '--mock') throw Error('Only --mock is supported; no application, configuration store or device is opened.')
// Audit known boundaries, not a guarantee of browser or persistent draft protection.
const cases: Array<Record<string, unknown>> = []
for (const kind of ['point', 'device'] as const) for (const path of ['device-button', 'history-reference', 'database-tab', 'background-removal'] as const) {
  const page = draftSurface(), modal = draftEditor(kind, page.registration())
  try {
    const before = page.render(); modal.change(); modal.close(); modal.resume()
    assert.equal(modal.calls.close, 0); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT')
    page.select(1); assert.equal(page.render().key, before.key); assert.equal(page.prompts.length, 0)
    const go = () => path === 'device-button' ? page.select(2) : path === 'history-reference' ? page.reference() : path === 'database-tab' ? page.global('database') : page.remove()
    if (path === 'background-removal') {
      go(); assert.equal(page.render().type, 'mock-empty-view'); assert.equal(page.prompts.length, 0)
      modal.driver.dispose()
      const retained = page.drafts.retained()
      assert.equal(retained.length, 1); assert(retained[0].snapshot?.text.includes('UNSAVED MOCK DRAFT'))
      const fresh = draftEditor(kind)
      try { assert.equal(fresh.value(), fresh.original) } finally { fresh.driver.dispose() }
      cases.push({ kind, path, protected: 'read-only-page-memory', inputRetained: true, editorRestored: false, automaticSaveCalls: modal.calls.save })
    } else {
      const state = page.state(); go(); assert.deepEqual(page.state(), state); assert.equal(page.prompts.length, 1); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT')
      page.setAnswer(true); go(); const after = page.render(); assert(after.type !== before.type || after.key !== before.key)
      assert.equal(page.prompts.length, 2); assert.equal(modal.calls.close, 0); assert.equal(modal.calls.save, 0)
      cases.push({ kind, path, protected: true, cancelledNavigationKeepsDraft: true, explicitDiscardAllowsNavigation: true, automaticSaveCalls: 0 })
    }
  } finally { modal.driver.dispose() }
}
assert.equal(cases.length, 8)
console.log(JSON.stringify({ audit: 'draft-unmount', mockOnly: true, productionFixApplied: 'active-navigation-and-detached-read-only-records', activeNavigationProtected: true, backgroundInputRetainedInPageMemory: true, editorRestoreSupported: false, cases, scope: 'actual source/components with mock state/dialogs; not browser accessibility, React DOM timing, persistence or device generation verification' }, null, 2))
