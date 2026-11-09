import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React, { type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { DeferredLiveSnapshotPanel, DeferredLiveSnapshotPanelView, liveSnapshotPanelResource } from '../apps/web/src/DeferredLiveSnapshotPanel.tsx'
import { LiveSnapshotPanel } from '../apps/web/src/LiveSnapshotPanel.tsx'
import { captureLiveSnapshot, liveSnapshotJson } from '../apps/web/src/live-snapshot.ts'
import { evaluateLivePoints } from '../apps/web/src/live-point-filter.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'

// Synthetic observations and explicit hook lifecycles only; no browser, API, database or driver.
type Renderer = typeof LiveSnapshotPanel
type Props = ComponentProps<Renderer>
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const now = Date.parse('2026-11-09T12:00:00Z')
function capture(id: number, slaveId: number, rawValue: number, capturedAt = now) {
  const device = { id, name: 'synthetic device ' + id, mode: 'master', isActive: 1 }
  const groups = [{ id: 10, name: 'synthetic group', slaveId, functionCode: 3, isActive: 1, registers: [{ id: 7, alias: 'synthetic point', startAddress: 0, functionCode: 3, dataType: 'uint16', factor: 1, offset: 0 }] }]
  const latest = { [sourceKey(id, 'holding-register', 0, slaveId)]: { rawValue, timestamp: new Date(now - 2000).toISOString(), timestampMs: now - 2000, quality: 'good', batchId: 'synthetic batch', slaveId } }
  const views = new Map([[7, { value: String(rawValue), label: null, invalid: false, covered: false }]])
  const states = evaluateLivePoints(groups, views, latest, device, [], {}, now, 5000)
  return captureLiveSnapshot({ device, groups, latest, views, states, visibleIds: new Set([7]), filters: { search: '', source: String(slaveId), mode: 'all' }, rulesReady: true, observedAt: now, capturedAt, thresholdMs: 5000 })
}
const first = capture(1, 1, 0), second = capture(2, 2, 42, now + 1000)
const base: Props = { snapshot: first, close() {}, download() { assert.fail('loading cannot initiate a download') } }
function wrapper(resource: DeferredResource<Renderer>, props = base) {
  const driver = hookDriver('DeferredLiveSnapshotPanel.tsx', 'DeferredLiveSnapshotPanel', hooks => ({ liveSnapshotPanelResource, DeferredLiveSnapshotPanelView,
    useSyncExternalStore(subscribe: (notify: () => void) => () => void, snapshot: () => unknown) { (hooks.useEffect as Function)(() => subscribe(() => {}), [subscribe]); return snapshot() },
  }), { ...props, resource })
  return { driver, update(next = props) { props = next; driver.render({ ...next, resource }) }, html: () => renderToStaticMarkup(driver.tree), view: () => driver.one(DeferredLiveSnapshotPanelView).props }
}
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('SNAPSHOT LOADING OK: ' + name) }

await check('actual App defers only the conditional preview and preserves comparison lifetime', () => {
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8')
  assert(source.includes("import { DeferredLiveSnapshotPanel as LiveSnapshotPanel } from './DeferredLiveSnapshotPanel'"))
  assert(!source.includes("from './LiveSnapshotPanel'")); assert(source.includes('{snapshot && <LiveSnapshotPanel key={snapshot.capturedAt}'))
  assert(source.includes('<LiveSnapshotComparison current={snapshotCapture} scope={snapshotComparisonScope}'))
  assert.equal(liveSnapshotPanelResource.snapshot().status, 'idle')
  const html = renderToStaticMarkup(React.createElement(DeferredLiveSnapshotPanel, base))
  assert(html.includes(first.capturedAt)); assert(html.includes('正在加载冻结快照预览'))
  assert.equal(liveSnapshotPanelResource.snapshot().status, 'idle', 'SSR must not start a code load')
})
await check('coalesced code arrival renders current immutable snapshot and current language', async () => {
  let imports = 0; const code = deferred<Renderer>(), resource = new DeferredResource<Renderer>(() => { imports++; return code.promise }), view = wrapper(resource)
  try {
    await tick(); assert.equal(imports, 1); assert.equal(resource.load(), resource.load())
    view.update({ ...base, snapshot: second, english: true }); assert(view.html().includes(second.capturedAt)); assert(!view.html().includes(first.capturedAt))
    code.resolve(LiveSnapshotPanel); await resource.load(); view.update()
    const element = DeferredLiveSnapshotPanelView(view.view())
    assert.equal(element.type, LiveSnapshotPanel); assert.equal(element.props.snapshot, second); assert.equal(element.props.english, true)
    assert(view.html().includes('Slave 2')); assert(view.html().includes('42')); assert(!view.html().includes('Slave 1'))
  } finally { view.driver.dispose() }
})
await check('failure exposes safe close and manual code retry without recapture or download', async () => {
  for (const english of [false, true]) {
    let imports = 0, closes = 0, downloads = 0
    const resource = new DeferredResource<Renderer>(async () => { if (++imports === 1) throw Error('PRIVATE chunk detail'); return LiveSnapshotPanel })
    const props = { ...base, english, close() { closes++ }, download() { downloads++ } }, before = liveSnapshotJson(first), view = wrapper(resource, props)
    try {
      await resource.load(); view.update(); assert(view.html().includes('role="alert"')); assert(!view.html().includes('PRIVATE')); assert(view.html().includes(english ? 'without freezing again' : '不会重新冻结'))
      const fallback = DeferredLiveSnapshotPanelView(view.view()), controls = (fallback.props as any).children
      controls[0].props.children[1].props.onClick(); assert.equal(closes, 1)
      await resource.load(); assert.equal(imports, 1, 'failed code must not auto retry')
      view.view().retry(); await resource.load(); view.update(); assert.equal(imports, 2); assert.equal(downloads, 0); assert.equal(liveSnapshotJson(first), before)
      assert.equal(DeferredLiveSnapshotPanelView(view.view()).type, LiveSnapshotPanel)
    } finally { view.driver.dispose() }
  }
})
await check('closing and device replacement discard old consumers while sharing cached code', async () => {
  const code = deferred<Renderer>(), resource = new DeferredResource<Renderer>(() => code.promise), old = wrapper(resource)
  await tick(); old.view().props.close(); old.driver.dispose()
  const current = wrapper(resource, { ...base, snapshot: second })
  try { code.resolve(LiveSnapshotPanel); await resource.load(); current.update(); assert.equal(old.driver.lateWrites, 0); assert.equal(DeferredLiveSnapshotPanelView(current.view()).props.snapshot, second) }
  finally { current.driver.dispose() }
})
await check('timeout needs manual retry and late obsolete code cannot replace the retry', async () => {
  let imports = 0; const old = deferred<Renderer>(), resource = new DeferredResource<Renderer>(() => ++imports === 1 ? old.promise : Promise.resolve(LiveSnapshotPanel), 5), view = wrapper(resource)
  try {
    await resource.load(); view.update(); assert(view.html().includes('加载失败')); view.driver.dispose()
    const reopened = wrapper(resource, { ...base, snapshot: second })
    try {
      await resource.load(); assert.equal(imports, 1); reopened.view().retry(); await resource.load(); const ready = resource.snapshot()
      old.resolve(() => { throw Error('obsolete renderer must not run') }); await tick(); assert.equal(resource.snapshot(), ready)
      reopened.update({ ...base, snapshot: second }); assert.equal(DeferredLiveSnapshotPanelView(reopened.view()).props.snapshot, second)
    } finally { reopened.driver.dispose() }
  } finally { view.driver.dispose() }
})
await check('ready code is reused across repeated previews without resetting captured values or age', async () => {
  let imports = 0; const resource = new DeferredResource<Renderer>(async () => { imports++; return LiveSnapshotPanel }), before = liveSnapshotJson(first), view = wrapper(resource)
  await resource.load(); view.update(); view.driver.dispose()
  const reopened = wrapper(resource)
  try { await resource.load(); reopened.update(); assert.equal(imports, 1); assert.equal(DeferredLiveSnapshotPanelView(reopened.view()).props.snapshot, first); assert.equal(first.points[0].health.ageSeconds, 2); assert.equal(liveSnapshotJson(first), before) }
  finally { reopened.driver.dispose() }
})
await check('loaded real preview exports only the passed frozen snapshot after an explicit click', async () => {
  let downloads = 0; const resource = new DeferredResource<Renderer>(async () => LiveSnapshotPanel), props = { ...base, snapshot: second, download(value: Props['snapshot']) { downloads++; assert.equal(value, second) } }, view = wrapper(resource, props)
  try {
    await resource.load(); view.update(); assert.equal(downloads, 0)
    const panel = hookDriver('LiveSnapshotPanel.tsx', 'LiveSnapshotPanel', { downloadLiveSnapshot: props.download }, DeferredLiveSnapshotPanelView(view.view()).props)
    try { panel.one('button', p => String(p.children).includes('JSON')).props.onClick(); assert.equal(downloads, 1); assert.equal(second.points[0].words[0].sample?.rawValue, 42) }
    finally { panel.dispose() }
  } finally { view.driver.dispose() }
})
console.log(`SNAPSHOT LOADING TEST OK: ${passed} groups`)
