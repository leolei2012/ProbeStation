import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { AssistantMarkdown } from '../apps/web/src/AssistantMarkdown.tsx'
import { DeferredAssistantMarkdown, AssistantMarkdownView, assistantMarkdownResource, type MarkdownRenderer } from '../apps/web/src/DeferredAssistantMarkdown.tsx'
import { AssistantMessage } from '../apps/web/src/AssistantMessage.tsx'
import { AssistantConversation } from '../apps/web/src/AssistantConversation.tsx'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let imports = 0
const module = deferred<MarkdownRenderer>(), started = deferred<void>()
const resource = new DeferredResource(async () => { imports++; started.resolve(); return module.promise })
assert.equal(imports, 0, 'constructing a display loader does not load anything')
assert.equal(assistantMarkdownResource.snapshot().status, 'idle')
const markup = renderToStaticMarkup(createElement(DeferredAssistantMarkdown, { content: '**正文**\n<script>unsafe</script>', resource }))
assert.equal(imports, 0, 'SSR cannot initiate display imports, model calls or other requests')
assert.match(markup, /\*\*正文\*\*/); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /当前为纯文本/)
let notifications = 0
const unsubscribe = resource.subscribe(() => { notifications++ })
const first = resource.load(), second = resource.load(), retryDuringLoad = resource.load(true)
assert.equal(first, second); assert.equal(first, retryDuringLoad)
await started.promise; assert.equal(imports, 1); assert.equal(resource.snapshot().status, 'loading')
unsubscribe(); const beforeClose = notifications
module.resolve(AssistantMarkdown); await first
assert.equal(notifications, beforeClose, 'closed messages are unsubscribed while the code may finish loading')
assert.equal(resource.snapshot().status, 'ready'); assert.ok(Object.isFrozen(resource.snapshot()))
await resource.load(); await resource.load(true); assert.equal(imports, 1, 'ready code is reused across later messages/openings')

let attempts = 0
const recoverable = new DeferredResource<MarkdownRenderer>(async () => { attempts++; if (attempts === 1) throw new Error('mock chunk 404 private detail'); return AssistantMarkdown })
await recoverable.load(); assert.equal(recoverable.snapshot().status, 'error')
assert.equal(JSON.stringify(recoverable.snapshot()).includes('private'), false)
await recoverable.load(); assert.equal(attempts, 1, 'new consumers do not create an automatic retry loop')
const retry1 = recoverable.load(true), retry2 = recoverable.load(true)
assert.equal(retry1, retry2); await retry1
assert.equal(attempts, 2); assert.equal(recoverable.snapshot().status, 'ready')
const late = deferred<MarkdownRenderer>(); let timedAttempts = 0
const timed = new DeferredResource<MarkdownRenderer>(async () => ++timedAttempts === 1 ? late.promise : AssistantMarkdown, 5)
await timed.load(); assert.equal(timed.snapshot().status, 'error')
await timed.load(true); assert.equal(timed.snapshot().status, 'ready')
const ready = timed.snapshot(); late.resolve(() => createElement('div', null, 'obsolete')); await Promise.resolve()
assert.equal(timed.snapshot(), ready, 'a late timed-out attempt cannot overwrite the successful manual retry')

let actions = 0
const plain = '**before**\n<em>literal</em>\n' + '正文'.repeat(100000) + '\nend-marker'
const view = (status: 'idle' | 'loading' | 'error' | 'ready', content = plain) => renderToStaticMarkup(createElement(AssistantMarkdownView, { content, state: { status, value: status === 'ready' ? AssistantMarkdown : null }, onRetry() { actions++ } }))
for (const status of ['idle', 'loading', 'error'] as const) { const html = view(status); assert.match(html, /\*\*before\*\*/); assert.match(html, /&lt;em&gt;literal&lt;\/em&gt;/); assert.match(html, /end-marker/); assert.ok(!html.includes('<em>literal</em>')) }
assert.match(view('error'), /重试富文本显示/); assert.doesNotMatch(view('loading'), /重试富文本显示/)
const rich = view('ready', '**latest**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n[reference](https://example.invalid/path)\n\n![alt](https://example.invalid/image.png)\n\n<script>unsafe</script>\n\n[bad](javascript:alert(1))')
assert.match(rich, /<strong>latest<\/strong>/); assert.match(rich, /<table>/); assert.match(rich, /<del>gone<\/del>/)
assert.match(rich, /target="_blank" rel="noopener noreferrer"/)
assert.match(rich, /图片：alt/); assert.doesNotMatch(rich, /<img|<script>|href="javascript:/)
assert.doesNotMatch(rich, /before/, 'ready renderer receives current content, never an old captured answer')
for (const role of ['user', 'tool', 'result']) assert.ok(renderToStaticMarkup(createElement(AssistantMessage, { role, content: 'plain <content>' })).includes('&lt;content&gt;'))
assert.equal(assistantMarkdownResource.snapshot().status, 'idle', 'user/tool/result messages do not request Markdown')
const conversation = renderToStaticMarkup(createElement(AssistantConversation, {
  entries: [{ role: 'user', content: 'question' }, { role: 'assistant', content: '**answer**' }], turns: [{ entryIndex: 0, startedAt: 1000, endedAt: 2000, state: 'completed' }],
  sources: [{ entryIndex: 0, deviceId: 1, view: 'history', label: 'mock-history-reference' }], onNavigate() { actions++ }, onSource() { actions++ },
}))
assert.match(conversation, /mock-history-reference/); assert.match(conversation, /\*\*answer\*\*/); assert.match(conversation, /已完成/)
assert.equal(actions, 0)
await assistantMarkdownResource.load()
assert.equal(assistantMarkdownResource.snapshot().status, 'ready', 'the actual deferred module contract resolves without a model or device service')
console.log('ASSISTANT RENDERER OK: deferred/coalesced imports, cached success, explicit retry, timeout/late result and unsubscribe, complete escaped plaintext, current rich/GFM/safe-link/image behavior, role/session references and pure SSR; no API, model, database, hardware or network')
