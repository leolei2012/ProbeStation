import assert from 'node:assert/strict'
// Run with: tsx --tsconfig tsconfig.web.json scripts/test-settings-loading.ts
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { DeferredSettingsModal, DeferredSettingsView, settingsResource, type SettingsRenderer } from '../apps/web/src/DeferredSettingsModal.tsx'
import type { SettingsModalProps } from '../apps/web/src/SettingsModal.tsx'
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let requests = 0, closes = 0, retries = 0, changes = 0, imports = 0
const props: SettingsModalProps = { initialSection: 'general', t: key => key, theme: 'light', lang: 'zh', setTheme() { changes++ }, setLang() { changes++ }, onClose() { closes++ }, onAISaved() { changes++ }, api: { async get() { requests++; return {} }, async post() { requests++; return {} } } }
const content = deferred<SettingsRenderer>(), started = deferred<void>()
const Fake: SettingsRenderer = value => createElement('p', null, value.theme + ':' + value.lang + ':' + value.initialSection)
const resource = new DeferredResource<SettingsRenderer>(async () => { imports++; started.resolve(); return content.promise })
assert.equal(settingsResource.snapshot().status, 'idle')
const server = renderToStaticMarkup(createElement(DeferredSettingsModal, { ...props, resource })); assert(server.includes('role="dialog"')); assert(server.includes('正在加载')); assert.equal(imports, 0); assert.equal(requests, 0, 'SSR of the closed-over loader never loads code or makes settings requests')
for (const lang of ['zh', 'en'] as const) for (const status of ['idle', 'loading', 'error'] as const) {
  const html = renderToStaticMarkup(createElement(DeferredSettingsView, { props: { ...props, lang }, state: { status, value: null }, retry() { retries++ } }))
  assert(html.includes('type="button"')); assert(html.includes('data-settings-close')); assert(html.includes(status === 'error' ? 'role="alert"' : 'role="status"'))
  if (status === 'error') assert(html.includes(lang === 'zh' ? '不会重放' : 'no settings action is retried'))
  else assert(!html.includes(lang === 'zh' ? '重试加载' : 'Retry loading'))
}
const first = resource.load(), second = resource.load(true); assert.equal(first, second); await started.promise; assert.equal(imports, 1)
let notices = 0; const unsubscribe = resource.subscribe(() => notices++); unsubscribe(); content.resolve(Fake); await first; assert.equal(notices, 0, 'closing the consumer cannot reopen it when code arrives')
await resource.load(); await resource.load(true); assert.equal(imports, 1, 'code survives close/reopen without a new import')
const latestProps = { ...props, theme: 'dark' as const, lang: 'en' as const, initialSection: 'ai' as const }
const ready = renderToStaticMarkup(createElement(DeferredSettingsView, { props: latestProps, state: resource.snapshot(), retry() { retries++ } })); assert(ready.includes('dark:en:ai')); assert(!ready.includes('light:zh:general'), 'loading never captures stale business props')
let attempts = 0
const retryable = new DeferredResource<SettingsRenderer>(async () => { if (++attempts === 1) throw new Error('PRIVATE asset load failure'); return Fake })
await retryable.load(); assert.equal(retryable.snapshot().status, 'error'); assert(!JSON.stringify(retryable.snapshot()).includes('PRIVATE')); await retryable.load(); assert.equal(attempts, 1, 'reopen does not auto retry failed code')
const retryA = retryable.load(true), retryB = retryable.load(true); assert.equal(retryA, retryB); await retryA; assert.equal(attempts, 2); assert.equal(retryable.snapshot().status, 'ready')
const late = deferred<SettingsRenderer>(); let timedCalls = 0
const timed = new DeferredResource<SettingsRenderer>(async () => ++timedCalls === 1 ? late.promise : Fake, 5)
await timed.load(); assert.equal(timed.snapshot().status, 'error'); await timed.load(true); const stable = timed.snapshot(); late.resolve(() => createElement('p', null, 'obsolete')); await Promise.resolve(); assert.equal(timed.snapshot(), stable)
// Module evaluation is code-only: no mounted effects, model API, database or hardware.
await settingsResource.load(); assert.equal(settingsResource.snapshot().status, 'ready')
const module = await import('../apps/web/src/SettingsModal.tsx'), moduleAgain = await import('../apps/web/src/SettingsModal.tsx')
assert.equal(module.SettingsModal, moduleAgain.SettingsModal); assert.equal(settingsResource.snapshot().value, module.SettingsModal)
for (const initialSection of ['general', 'ai'] as const) {
  const html = renderToStaticMarkup(createElement(module.SettingsModal, { ...props, initialSection }))
  assert(html.includes('data-settings-close')); assert(html.includes('settings-nav')); assert(html.includes('ai-settings')); assert(html.includes(initialSection === 'general' ? 'themeLabel' : 'API 密钥'))
}
assert.deepEqual({ requests, closes, retries, changes }, { requests: 0, closes: 0, retries: 0, changes: 0 }, 'code loading/SSR never saves, restores, clears, changes preferences or calls models')
console.log('SETTINGS LOADING OK: no import/request during SSR, shared cached code, explicit retry/timeout/late-result isolation, closed consumer unsubscribe, current props, bilingual close/error fallback, actual module contract and preserved general/AI structure; no fetch, model, device, files or browser automation')
