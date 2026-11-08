import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { communicationScope, CommunicationSummaryRead } from '../apps/web/src/communication-summary.ts'

const source = readFileSync(new URL('../apps/web/src/CommunicationSummary.tsx', import.meta.url), 'utf8')
assert(!source.includes('function CommunicationSummaryView('), 'collapsed communication statistics must not statically include the detailed renderer')
const { CommunicationSummary } = await import('../apps/web/src/CommunicationSummary.tsx')
const { CommunicationSummaryView } = await import('../apps/web/src/CommunicationSummaryView.tsx')
const { DeferredCommunicationSummary, DeferredCommunicationSummaryView, communicationSummaryResource } = await import('../apps/web/src/DeferredCommunicationSummary.tsx')
type Renderer = typeof CommunicationSummaryView
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const device = { id: 1, transport: 'tcp', ip: 'mock.invalid', port: 502 }
const raw = (value = device, connected = false) => ({ ...communicationScope(value), connected, metrics: null })
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('COMMUNICATION LOADING OK: ' + name) }
// Shared deterministic hook cells, explicit renders and cleanup; no React DOM or native browser.
const scope = (extra: Record<string, unknown>) => (hooks: Record<string, any>) => ({ ...extra,
  useMemo(factory: () => unknown, deps: unknown[]) { const ref = hooks.useRef(); if (!ref.current || deps.some((value, i) => !Object.is(value, ref.current.deps[i]))) ref.current = { value: factory(), deps }; return ref.current.value },
  useSyncExternalStore(subscribe: (notify: () => void) => () => void, snapshot: () => unknown) { hooks.useEffect(() => subscribe(() => {}), [subscribe]); return snapshot() },
})
function control(get: (url: string, signal: AbortSignal) => Promise<unknown>, initial = device) {
  let props = { device: initial, english: true, get }
  const driver = hookDriver('CommunicationSummary.tsx', 'CommunicationSummaryControl', scope({ communicationScope, CommunicationSummaryRead, DeferredCommunicationSummary }), props)
  return { driver, toggle() { driver.one('button').props.onClick(); driver.render() }, update(next = props.device) { props = { ...props, device: next }; driver.render(props) }, panel: () => driver.one(DeferredCommunicationSummary).props }
}
function wrapper(resource: DeferredResource<Renderer>, props: any) {
  const driver = hookDriver('DeferredCommunicationSummary.tsx', 'DeferredCommunicationSummary', scope({ communicationSummaryResource, DeferredCommunicationSummaryView }), { ...props, resource })
  return { driver, update(next: any) { driver.render({ ...next, resource }) }, html: () => renderToStaticMarkup(driver.tree) }
}
await check('collapsed controls and unsupported sources import no view and issue no statistics read', () => {
  let reads = 0
  assert.equal(communicationSummaryResource.snapshot().status, 'idle')
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(CommunicationSummary, { device, english, get: async () => { reads++; throw Error('no read during SSR') } }))
    assert(html.includes('aria-expanded="false"')); assert(!html.includes('Read-only communication statistics'))
  }
  assert(renderToStaticMarkup(React.createElement(CommunicationSummary, { device: { id: 1, transport: 'unsupported' } })).includes('未请求统计'))
  const model = control(async () => { reads++; return raw() }); model.driver.dispose()
  assert.equal(reads, 0); assert.equal(communicationSummaryResource.snapshot().status, 'idle')
})
await check('first expansion coalesces code loads and preserves one independent metadata read', async () => {
  const code = deferred<Renderer>(); let imports = 0, reads = 0
  const resource = new DeferredResource<Renderer>(() => { imports++; return code.promise })
  const model = control(async () => { reads++; return raw() }); model.toggle()
  const view = wrapper(resource, model.panel())
  try {
    assert(view.html().includes('Loading communication statistics interface')); await tick(); assert.equal(imports, 1); assert.equal(reads, 1)
    assert.equal(resource.load(), resource.load()); code.resolve(CommunicationSummaryView); await resource.load(); model.update(); view.update(model.panel())
    assert(view.html().includes('No diagnostic counters')); assert(view.html().includes('Not connected')); assert.equal(reads, 1)
  } finally { view.driver.dispose(); model.driver.dispose() }
})
await check('bilingual code errors retry only the interface and retain current statistics without re-reading', async () => {
  for (const english of [false, true]) {
    let imports = 0, reads = 0
    const resource = new DeferredResource<Renderer>(async () => { if (++imports === 1) throw Error('synthetic chunk failure'); return CommunicationSummaryView })
    const model = control(async () => { reads++; return raw() }); model.toggle(); await tick(); model.update()
    const view = wrapper(resource, { ...model.panel(), english })
    try {
      await resource.load(); view.update({ ...model.panel(), english })
      assert(view.html().includes(english ? 'interface could not be loaded' : '界面加载失败')); assert(view.html().includes('role="alert"'))
      view.driver.one(DeferredCommunicationSummaryView).props.retry(); await resource.load(); view.update({ ...model.panel(), english })
      assert(view.html().includes(english ? 'No diagnostic counters' : '没有提供诊断计数')); assert.equal(imports, 2); assert.equal(reads, 1)
    } finally { view.driver.dispose(); model.driver.dispose() }
  }
})
await check('close and late code completion never reopen statistics; reopening reuses code and refreshes normally', async () => {
  let imports = 0, reads = 0
  const code = deferred<Renderer>(), metadata = deferred<unknown>(), signals: AbortSignal[] = [], resource = new DeferredResource<Renderer>(() => { imports++; return code.promise })
  const model = control(async (_url, signal) => { signals.push(signal); return ++reads === 1 ? metadata.promise : raw() }); model.toggle(); const view = wrapper(resource, model.panel()); await tick()
  model.toggle(); view.driver.dispose(); assert.equal(model.driver.one('button').props['aria-expanded'], false)
  assert(signals[0].aborted); metadata.reject(Error('obsolete metadata failure'))
  code.resolve(CommunicationSummaryView); await resource.load(); assert.throws(() => model.panel()); assert.equal(imports, 1); assert.equal(reads, 1)
  model.toggle(); await tick(); model.update(); const reopened = wrapper(resource, model.panel())
  try { await resource.load(); assert(reopened.html().includes('No diagnostic counters')); assert.equal(imports, 1); assert.equal(reads, 2); assert.equal(view.driver.lateWrites, 0) }
  finally { reopened.driver.dispose(); model.driver.dispose() }
})
await check('A/B/A and same-ID connection changes retain current props while old metadata and code complete late', async () => {
  const requests: Array<{ signal: AbortSignal; response: ReturnType<typeof deferred<unknown>> }> = []
  const code = deferred<Renderer>(), resource = new DeferredResource<Renderer>(() => code.promise)
  const model = control(async (_url, signal) => { const response = deferred<unknown>(); requests.push({ signal, response }); return response.promise })
  model.toggle(); const view = wrapper(resource, model.panel()); await tick()
  const b = { ...device, id: 2 }; model.update(b); await tick(); assert(requests[0].signal.aborted)
  model.update(); view.update(model.panel()); assert.equal(model.panel().state.value, undefined)
  requests[1].response.resolve(raw(b, true)); await tick(); model.update(); view.update(model.panel())
  const a2 = { ...device, ip: 'second.mock.invalid' }; model.update(a2); await tick()
  requests[2].response.resolve(raw(a2, false)); requests[0].response.resolve(raw(device, true)); await tick(); model.update(); view.update(model.panel())
  code.resolve(CommunicationSummaryView); await resource.load(); view.update(model.panel())
  assert.equal(model.panel().state.value.objectId, 1); assert.equal(model.panel().state.value.connected, false)
  assert(view.html().includes('Not connected')); assert(!view.html().includes('UTC · #2'))
  const a3 = { ...a2, port: 503 }; model.update(a3); await tick(); assert.equal(model.panel().state.value, undefined)
  const a4 = { ...a3, port: 504 }; model.update(a4); await tick(); assert(requests[3].signal.aborted)
  requests[4].response.resolve(raw(a4, false)); requests[3].response.resolve(raw(a3, true)); await tick(); model.update(); view.update(model.panel()); assert(view.html().includes('Not connected'))
  assert.equal(model.panel().state.value.connected, false, 'same-ID old connection completion cannot replace the current reader')
  view.driver.dispose(); model.driver.dispose()
})
await check('metadata failure remains distinct from code failure and manual read keeps its existing recovery behavior', async () => {
  let reads = 0
  const model = control(async () => { if (++reads === 1) throw Error('synthetic metadata failure'); return raw() }); model.toggle(); await tick(); model.update()
  const resource = new DeferredResource<Renderer>(async () => CommunicationSummaryView), view = wrapper(resource, model.panel())
  try {
    await resource.load(); view.update(model.panel()); assert(view.html().includes('Statistics read failed')); assert(!view.html().includes('interface could not be loaded'))
    view.driver.one(DeferredCommunicationSummaryView).props.props.refresh(); await tick(); model.update(); view.update(model.panel())
    assert(view.html().includes('No diagnostic counters')); assert.equal(reads, 2)
  } finally { view.driver.dispose(); model.driver.dispose() }
})
await check('import timeout ignores late results until explicit retry and real renderer loads without a request', async () => {
  const slow = deferred<Renderer>(); let imports = 0
  const resource = new DeferredResource<Renderer>(() => ++imports === 1 ? slow.promise : Promise.resolve(CommunicationSummaryView), 5)
  await resource.load(); assert.equal(resource.snapshot().status, 'error'); slow.resolve(CommunicationSummaryView); await tick(); assert.equal(resource.snapshot().status, 'error')
  await resource.load(true); assert.equal(resource.snapshot().status, 'ready'); assert.equal(imports, 2)
  await communicationSummaryResource.load(); assert.equal(communicationSummaryResource.snapshot().status, 'ready')
})
assert.equal(passed, 7)
console.log('COMMUNICATION LOADING TEST OK: 7 actual control/wrapper/read lifecycle and bilingual SSR groups; no browser, network, hardware, database, model or write operation')
