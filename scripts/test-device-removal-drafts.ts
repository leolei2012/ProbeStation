import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import ts from 'typescript'
import { ConfigStore } from '../packages/config/src/index.ts'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { if (process.argv[2] && !name.startsWith(process.argv[2])) return; await fn(); passed++; console.log('DEVICE REMOVAL DRAFT OK: ' + name) }
await check('unverified retained list cannot confirm or dispatch a fresh deletion', async () => {
  for (const english of [false, true]) for (const phase of ['loading', 'failed']) {
    const page = draftSurface({ english }), modal = draftEditor('point', page.registration()), original = page.render().props.device
    let requests = 0, release = () => {}, reading: Promise<void> | undefined
    try {
      modal.change('UNSAVED RETAINED LIST'); page.setAnswer(true)
      if (phase === 'loading') reading = page.refresh(() => new Promise(resolve => { release = () => resolve([original]) }))
      else await page.refresh(async () => { throw Error('synthetic list failure') })
      await page.deleteDevice(1, async () => { requests++; return { ok: true } })
      assert.equal(requests, 0, 'a stale retained list must not dispatch a new DELETE')
      assert.equal(page.prompts.length, 0); assert.equal(page.drafts.retained().length, 0); assert.equal(page.state().selectedId, 1)
      assert.equal(modal.value(), 'UNSAVED RETAINED LIST'); assert.equal(modal.calls.save, 0)
      assert.match(page.notices.at(-1)!.text, english ? /list.*unverified/i : /清单.*未核实/)
      if (reading) { release(); await reading } else await page.refresh(async () => [original])
      assert.equal(requests, 0, 'read recovery never automatically repeats deletion')
      await page.deleteDevice(1, async () => { requests++; return { ok: true } }); assert.equal(requests, 1)
    } finally { release(); await reading; modal.driver.dispose() }
  }
})
await check('list read failure never cancels an admitted deletion or labels its result known', async () => {
  const page = draftSurface(), modal = draftEditor('device', page.registration()), response = deferred(); let requests = 0
  try {
    modal.change('PENDING DELETE DRAFT'); page.setAnswer(true)
    const deleting = page.deleteDevice(1, async () => { requests++; await response.promise; throw new TypeError('synthetic lost deletion response') })
    assert.equal(requests, 1); await page.refresh(async () => { throw Error('synthetic list failure') })
    response.resolve(); await deleting
    assert.equal(requests, 1); assert.match(page.notices.at(-1)!.text, /删除结果待核实/)
    assert.equal(page.drafts.retained().length, 1); modal.submit(false); assert.equal(modal.calls.save, 0)
    await page.deleteDevice(1, async () => { requests++; return { ok: true } }); assert.equal(requests, 1)
    assert.match(page.notices.at(-1)!.text, /先前删除结果仍须单独核实/)
  } finally { response.resolve(); await tick(); modal.driver.dispose() }
})
await check('confirmed deletion retains dirty editors before selection clears, without saving or relying on list refresh', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration()); let deleted = 0, refreshed = 0
    try {
      modal.change('RAW DELETE DRAFT'); page.setAnswer(true)
      await page.deleteDevice(1, async () => { deleted++; return { ok: true } }, () => { refreshed++ })
      assert.equal(deleted, 1); assert.equal(refreshed, 1); assert.equal(page.state().selectedId, null)
      modal.driver.dispose(); assert.equal(page.drafts.retained().length, 1, 'active deletion must retain input before forced unmount')
      assert(page.drafts.retained()[0].snapshot?.text.includes('RAW DELETE DRAFT')); assert.equal(modal.calls.save, 0); assert.equal(page.prompts.length, 1)
    } finally { modal.driver.dispose() }
  }
})
await check('saving or unreadable affected editor prevents deletion; unrelated saving owner does not block', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), wait = deferred(), modal = draftEditor(kind, page.registration(), () => wait.promise); let requests = 0
    try {
      modal.change(); modal.submit(false); page.setAnswer(true)
      await page.deleteDevice(1, async () => { requests++; return { ok: true } })
      assert.equal(requests, 0); assert.equal(page.prompts.length, 0); assert.equal(page.drafts.retained().length, 0); assert.equal(modal.calls.save, 1)
      await page.deleteDevice(2, async () => { requests++; return { ok: true } }); assert.equal(requests, 1); assert.equal(page.state().selectedId, 1)
    } finally { wait.reject(Error('mock unknown save')); await tick(); modal.driver.dispose() }
  }
  const page = draftSurface(); page.drafts.scope(1).register('live', () => { throw Error('mock unavailable') }); page.setAnswer(true)
  let requested = 0; await page.deleteDevice(1, async () => { requested++; return null }); assert.equal(requested, 0); assert.equal(page.prompts.length, 0)
})
await check('cancel/dialog failure has no side effects; delete waits revoke existing and newly opened same-owner saves', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), modal = draftEditor(kind, page.registration()), wait = deferred(); let requested = 0
    try {
      modal.change(); const send = async () => { requested++; await wait.promise; return { ok: true } }
      await page.deleteDevice(1, send); assert.equal(requested, 0); assert.equal(page.drafts.retained().length, 0)
      page.setAnswer(Error('mock confirmation unavailable')); await page.deleteDevice(1, send); assert.equal(requested, 0)
      page.setAnswer(true); const removing = page.deleteDevice(1, send); assert.equal(requested, 1)
      modal.submit(false); assert.equal(modal.calls.save, 0); assert.equal(page.drafts.retained().length, 1)
      const fresh = draftEditor(kind, page.registration())
      try { fresh.submit(false); assert.equal(fresh.calls.save, 0, 'new same-owner editor cannot race the pending delete'); fresh.driver.render(); assert.equal(fresh.driver.one('button', props => props.type === 'submit').props.disabled, true) } finally { fresh.driver.dispose() }
      const foreign = draftEditor(kind, page.drafts.scope(2))
      try { foreign.submit(); await tick(); assert.equal(foreign.calls.save, 1) } finally { foreign.driver.dispose() }
      const prompts = page.prompts.length; await page.deleteDevice(1, send); assert.equal(requested, 1, 'operation lock prevents repeated delete dispatch'); assert.equal(page.prompts.length, prompts)
      wait.resolve(); await removing; assert.equal(page.drafts.retained().length, 1)
    } finally { wait.resolve(); await tick(); modal.driver.dispose() }
  }
})
await check('late delete success does not clear a newer selection; failures retain and never auto-resume old editor', async () => {
  for (const english of [false, true]) {
    const page = draftSurface({ english }), modal = draftEditor('device', page.registration()), wait = deferred(); page.setAnswer(true)
    try {
      modal.change(); const removing = page.deleteDevice(1, async () => { await wait.promise; return { ok: true } })
      page.select(2); assert.equal(page.state().selectedId, 2); wait.resolve(); await removing; assert.equal(page.state().selectedId, 2)
    } finally { wait.resolve(); await tick(); modal.driver.dispose() }
    for (const error of [new TypeError('mock lost response'), new Error('HTTP 500 mock post-delete failure'), new Error('HTTP 409 rejected')]) {
      const failed = draftSurface({ english }), old = draftEditor('point', failed.registration()); let requested = 0
      try {
        old.change(); failed.setAnswer(true); await failed.deleteDevice(1, async () => { requested++; throw error })
        assert.equal(requested, 1); assert.equal(failed.state().selectedId, 1); assert.equal(failed.drafts.retained().length, 1); old.submit(); assert.equal(old.calls.save, 0)
        const notice = failed.notices.at(-1)!; assert(notice.error); assert(notice.text.includes(error.message.includes('409') ? '409' : english ? 'unverified' : '待核实'))
      } finally { old.driver.dispose() }
    }
  }
})
await check('save guard checks deletion even before editor registration effect runs', async () => {
  for (const kind of ['point', 'device'] as const) for (const mountedBefore of [false, true]) {
    const page = draftSurface(), wait = deferred(); page.setAnswer(true)
    const delayedScope = { register() { return () => {} }, removalPending: () => page.drafts.removalPending(1) }
    let modal = mountedBefore ? draftEditor(kind, delayedScope) : undefined
    try {
      const removing = page.deleteDevice(1, async () => { await wait.promise; return { ok: true } })
      modal ??= draftEditor(kind, delayedScope)
      modal.submit(false); assert.equal(modal.calls.save, 0, 'a pending deletion must gate saves without relying on passive registration')
      wait.resolve(); await removing
    } finally { wait.resolve(); await tick(); modal?.driver.dispose() }
  }
})
await check('actual DELETE route commits or loses response using memory configuration only, without retry or fake input save', async () => {
  const cfg = new ConfigStore({ dbPath: ':memory:' }), api = Fastify()
  const device = cfg.createObject('synthetic deleted', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'mock', 3, 0, 1), point = cfg.createRegister(group.id, device.id, 'mock', 3, 0, 'uint16'); cfg.createRule(point.id, '>', 1, 'mock')
  const source = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let route!: ts.CallExpression
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'delete' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/monitor_objects/:id') route = node; ts.forEachChild(node, visit) }; visit(source); assert(route)
  new Function('fastify', 'cfg', 'ctx', ts.transpileModule(route.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(api, cfg, { get() { return undefined } })
  const page = draftSurface(), modal = draftEditor('device', page.registration()); let requests = 0
  try {
    assert.equal(device.id, 1); modal.change(); page.setAnswer(true)
    await page.deleteDevice(1, async url => { requests++; const response = await api.inject({ method: 'DELETE', url }); assert.equal(response.statusCode, 200); throw new TypeError('mock response lost after commit') })
    assert.equal(requests, 1); assert.equal(cfg.listObjects().length, 0); assert.equal(cfg.listGroups(device.id).length, 0); assert.equal(cfg.listRegistersByObject(device.id).length, 0); assert.equal(cfg.listRules().length, 0)
    assert.equal(page.drafts.retained().length, 1); assert.equal(page.state().selectedId, 1); assert.match(page.notices.at(-1)!.text, /待核实/); assert.equal(modal.calls.save, 0)
  } finally { modal.driver.dispose(); await api.close(); cfg.close() }
})
await check('post-confirm busy recheck and capture failure stop dispatch; clean editors and operation lock are isolated', async () => {
  const changed = draftSurface(); let reads = 0, requests = 0
  changed.drafts.scope(1).register('live', () => ({ dirty: true, busy: ++reads > 1 }), () => ({ context: 'mock', text: 'never capture' }))
  changed.setAnswer(true); await changed.deleteDevice(1, async () => { requests++; return null }); assert.equal(requests, 0); assert.equal(changed.prompts.length, 1); assert.equal(changed.drafts.retained().length, 0)
  const failed = draftSurface(); failed.drafts.scope(1).register('live', () => ({ dirty: true, busy: false }), () => { throw Error('synthetic capture failure') }); failed.setAnswer(true)
  await failed.deleteDevice(1, async () => { requests++; return null }); assert.equal(requests, 0); assert.equal(failed.retentionNotice().props.records[0].snapshot, null); assert(!failed.drafts.removalPending(1))
  await failed.deleteDevice(1, async () => { requests++; return null }); assert.equal(requests, 0, 'a failed capture cannot be bypassed by repeating delete')
  const clean = draftSurface(), old = draftEditor('point', clean.registration()), wait = deferred(); clean.setAnswer(true)
  try {
    const removing = clean.deleteDevice(1, async () => { await wait.promise; return { ok: true } })
    assert.equal(clean.drafts.retained().length, 0); old.submit(false); assert.equal(old.calls.save, 0); wait.resolve(); await removing; assert(!clean.drafts.removalPending(1))
  } finally { wait.resolve(); await tick(); old.driver.dispose() }
  const locked = draftSurface(), modal = draftEditor('device', locked.registration()), pending = deferred(); locked.setAnswer(true)
  try {
    modal.change(); const first = locked.deleteDevice(2, async () => { await pending.promise; return { ok: true } })
    await locked.deleteDevice(1, async () => { requests++; return null }); assert.equal(requests, 0); assert.equal(locked.drafts.retained().length, 0)
    modal.submit(); await tick(); assert.equal(modal.calls.save, 1, 'operation lock skip must not seal another owner'); pending.resolve(); await first
  } finally { pending.resolve(); await tick(); modal.driver.dispose() }
})
assert(passed > 0, 'test filter must match a case')
console.log('DEVICE REMOVAL DRAFT TEST OK: ' + passed + ' actual UI/operation/DELETE and memory-only groups; no device, listener, real data or browser')
