import assert from 'node:assert/strict'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'
import { bindBeforeUnload } from '../apps/web/src/before-unload.ts'
import { unloadTarget } from './fixtures/unload-events.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('BEFORE UNLOAD OK: ' + name) }
await check('actual editors bind only while at risk, revert/cleanup removes the listener, event never saves or discards', () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration())
    try {
      assert.equal(modal.window.count(), 0); assert.equal(modal.window.fire().prevented, 0)
      modal.change(); assert.equal(modal.window.count(), 1); const event = modal.window.fire()
      assert.equal(event.prevented, 1, 'dirty editor should request the browser native warning'); assert(event.returnValue)
      assert.equal(modal.calls.save, 0); assert.equal(modal.calls.close, 0); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT'); assert.equal(page.prompts.length, 0)
      modal.window.fire(); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT'); modal.change(modal.original)
      assert.equal(modal.window.count(), 0); assert.equal(modal.window.fire().prevented, 0)
      modal.change(); modal.driver.dispose(); assert.equal(modal.window.count(), 0)
    } finally { modal.driver.dispose() }
  }
})
await check('close confirmation/resume and failed save remain protected; explicit discard has no ghost warning', async () => {
  for (const kind of ['point', 'device'] as const) {
    let reject!: (error: Error) => void; const pending = new Promise<void>((_resolve, no) => { reject = no })
    const modal = draftEditor(kind, undefined, () => pending)
    try {
      modal.change(); modal.close(); assert(modal.window.fire().prevented); modal.resume(); assert(modal.window.fire().prevented)
      modal.submit(false); assert(modal.window.fire().prevented, 'already installed listener checks busy before rerender'); assert.equal(modal.calls.save, 1)
      reject(Error('synthetic uncertain save')); await tick(); modal.driver.render(); assert(modal.window.fire().prevented)
      modal.close(); modal.discard(); assert.equal(modal.window.fire().prevented, 0); assert.equal(modal.window.count(), 0); assert.equal(modal.calls.save, 1)
    } finally { reject(Error('cleanup')); await tick(); modal.driver.dispose() }
  }
})
await check('read-only records survive editor cleanup and navigation; last discard clears risk even before effect cleanup', () => {
  const page = draftSurface(), modal = draftEditor('point', page.registration())
  let release: undefined | (() => void)
  try {
    modal.change(); page.remove(); modal.driver.dispose(); release = page.mountUnload()
    assert.equal(page.window.count(), 1); assert(page.window.fire().prevented)
    page.select(2); page.global('database'); assert(page.window.fire().prevented); assert.equal(page.drafts.retained().length, 1)
    const record = page.retentionNotice().props.records[0]; page.setAnswer(false); page.retentionNotice().props.onDiscard(record.id); assert(page.window.fire().prevented)
    page.setAnswer(true); page.retentionNotice().props.onDiscard(record.id); assert.equal(page.window.fire().prevented, 0, 'latest memory getter prevents stale native warnings')
    release?.(); release = page.mountUnload(); assert.equal(page.window.count(), 0)
  } finally { release?.(); modal.driver.dispose() }
})
await check('clean pending saves and the root add-device dialog request warnings without a device registration', async () => {
  for (const kind of ['point', 'device'] as const) {
    let resolve!: () => void; const pending = new Promise<void>(yes => { resolve = yes })
    const modal = draftEditor(kind, undefined, () => pending)
    try {
      modal.submit(); assert(modal.window.fire().prevented); resolve(); await tick(); modal.driver.render()
      assert.equal(modal.window.fire().prevented, 0); assert.equal(modal.window.count(), 0); assert.equal(modal.calls.save, 1)
    } finally { resolve(); await tick(); modal.driver.dispose() }
  }
  const add = draftEditor('device', undefined, undefined, null, undefined, null)
  try { assert.equal(add.window.count(), 0); add.change('unsaved new device'); assert(add.window.fire().prevented); assert.equal(add.calls.save, 0) } finally { add.driver.dispose() }
})
await check('binding checks current risk, fails conservatively and cleans up only its own handler', () => {
  const target = unloadTarget(); let unrelated = 0, risk = false
  const other = () => { unrelated++ }; target.addEventListener('beforeunload', other)
  assert.equal(bindBeforeUnload(target as any, false, () => { throw Error('must not read') }), undefined); assert.equal(target.count(), 1)
  const dispose = bindBeforeUnload(target as any, true, () => risk)!
  assert.equal(target.fire().prevented, 0); risk = true; const event = target.fire(); assert.equal(event.prevented, 1); assert.equal(event.returnValue, ' ')
  assert.equal(unrelated, 2); dispose(); dispose(); assert.equal(target.count(), 1); assert.equal(target.fire().prevented, 0)
  const unknown = bindBeforeUnload(target as any, true, () => { throw Error('private synthetic contents') })!
  const failure = target.fire(); assert.equal(failure.prevented, 1); assert.equal(failure.returnValue, ' '); unknown(); target.removeEventListener('beforeunload', other); assert.equal(target.count(), 0)
})
await check('multiple editors share a native event without custom confirmation and independently release risk', () => {
  const page = draftSurface(), point = draftEditor('point', page.registration(), undefined, null, page.window), device = draftEditor('device', page.registration(), undefined, null, page.window)
  try {
    assert.equal(page.window.count(), 0); point.change(); device.change(); assert.equal(page.window.count(), 2)
    assert(page.window.fire().prevented); assert.equal(page.prompts.length, 0); assert.equal(point.calls.save + device.calls.save, 0)
    point.close(); point.discard(); assert.equal(page.window.count(), 1); assert(page.window.fire().prevented)
    device.change(device.original); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0)
  } finally { point.driver.dispose(); device.driver.dispose() }
})
console.log('BEFORE UNLOAD TEST OK: ' + passed + ' actual editor/effect groups with simulated events; no native dialog, page close, persistence or recovery claim')
