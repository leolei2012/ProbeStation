import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttachmentBatchRead, readAttachmentBase64, prepareAttachmentFiles, type AttachmentFile, type LocalAttachment } from '../apps/web/src/assistant-attachment-read.ts'
import { AssistantAttachmentReadStatus } from '../apps/web/src/AssistantAttachmentReadStatus.tsx'
import { parseAttachments } from '../packages/api/src/assistant-attachments.ts'

// Synthetic metadata, memory Blobs and fake FileReader only; never read user files or call a model/API.
const file = (name = 'test.txt', size = 1, type = 'text/plain') => ({ name, size, type })
const blob = new Blob(['A']), text = Buffer.from('A').toString('base64')
class FakeReader {
  result: unknown = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  starts = 0; aborts = 0; throwRead = false
  readAsDataURL() { this.starts++; if (this.throwRead) throw new Error('synthetic failure') }
  abort() { this.aborts++; this.onabort?.() }
  load(data = 'data:text/plain;base64,' + text) { this.result = data; this.onload?.() }
}
const factory = (reader: FakeReader) => () => reader as unknown as FileReader
{
  const reader = new FakeReader(), controller = new AbortController()
  const result = readAttachmentBase64(blob, controller.signal, factory(reader)); reader.load(); assert.equal(await result, text)
  assert.equal(reader.onload, null); assert.equal(reader.onerror, null); assert.equal(reader.onabort, null); controller.abort(); assert.equal(reader.aborts, 0, 'successful read removes the abort listener')
}
for (const mode of ['error', 'abort', 'reader-abort', 'invalid', 'empty', 'throw']) {
  const reader = new FakeReader(), controller = new AbortController(); reader.throwRead = mode === 'throw'
  const result = readAttachmentBase64(blob, controller.signal, factory(reader)), rejected = assert.rejects(result)
  if (mode === 'error') reader.onerror?.()
  if (mode === 'abort') controller.abort()
  if (mode === 'reader-abort') reader.onabort?.()
  if (mode === 'invalid') reader.load('not-a-data-url')
  if (mode === 'empty') reader.load('data:text/plain;base64,')
  await rejected; assert.equal(reader.onload, null); assert.equal(reader.onerror, null); assert.equal(reader.onabort, null)
}
{
  const controller = new AbortController(); controller.abort(); let factories = 0
  await assert.rejects(readAttachmentBase64(blob, controller.signal, () => { factories++; return new FakeReader() as any })); assert.equal(factories, 0)
}
const busy: boolean[] = [], errors: unknown[] = [], readers: FakeReader[] = [], draft: LocalAttachment[] = [{ name: 'existing.txt', size: 1, data: text }]
const model = new AttachmentBatchRead<AttachmentFile>({
  read: (_file, signal) => { const reader = new FakeReader(); readers.push(reader); return readAttachmentBase64(blob, signal, factory(reader)) },
  busy: value => busy.push(value), failed: error => errors.push(error), accepted: files => draft.push(...files),
})
assert.equal(readers.length, 0, 'construction does not read files')
await model.start([]); assert.equal(busy.length, 0)
await model.start([file(), file('unsupported.pdf')]); assert.equal(readers.length, 0, 'all metadata is checked before any read'); assert.equal(draft.length, 1); assert.equal(errors.length, 1)
const failed = model.start([file('failed.txt'), file('sibling.txt')]); readers[0].onerror?.(); await failed
assert.equal(readers[1].aborts, 1, 'batch failure aborts the still-reading sibling'); assert.equal(draft.length, 1); assert.equal(errors.length, 2)
const cancelled = model.start([file('old-a.txt'), file('old-b.txt')]), late = readers[2].onload!
assert.equal(model.reading, true, 'synchronous guard is available before React can render busy state')
assert.equal(model.cancel(), true); assert.equal(model.cancel(), false); assert.equal(readers[2].aborts, 1); assert.equal(readers[3].aborts, 1)
assert.equal(model.reading, false)
const next = model.start([file('new.txt')]); await cancelled
assert.equal(model.reading, true)
await model.start([file('must-not-start.txt')]); assert.equal(readers.length, 5, 'old finally must not release the new batch lock')
readers[2].result = 'data:text/plain;base64,' + text; late(); readers[4].load(); await next
assert.deepEqual(draft.map(row => row.name), ['existing.txt', 'new.txt']); assert.equal(errors.length, 2); assert.equal(busy.at(-1), false)
const unmounted = model.start([file('unmounted.txt')]), notices = busy.length
model.cancel(false); await unmounted; assert.equal(busy.length, notices, 'unmount cancellation does not publish state'); assert.equal(draft.length, 2)
const remounted = model.start([file('remounted.txt')]); readers[6].load(); await remounted; assert.equal(draft.at(-1)?.name, 'remounted.txt', 'effect cleanup/remount can reuse the local read model')
const order = model.start([file('first.txt'), file('second.txt')]); readers[8].load(); readers[7].load(); await order
assert.deepEqual(draft.slice(-2).map(row => row.name), ['first.txt', 'second.txt'], 'file selection order survives out-of-order completion')
assert.deepEqual(parseAttachments(draft.map(({ name, data }) => ({ name, data }))).map(row => row.name), draft.map(row => row.name), 'queued text payload remains compatible with the server parser')
for (const input of [file('a.txt', 0), file('a.txt', -1), file('a.txt', 1.5), file('a.pdf'), file('')]) assert.throws(() => prepareAttachmentFiles([input]))
assert.equal(prepareAttachmentFiles([file('clipboard', 1, 'image/png')])[0].name, 'clipboard.png')
assert.equal(prepareAttachmentFiles([file('', 1, 'image/jpeg')])[0].name, '粘贴图片.jpg')
assert.equal(prepareAttachmentFiles([file('EXISTING.JPEG', 1, 'image/jpeg')])[0].name, 'EXISTING.JPEG')
assert.equal(prepareAttachmentFiles(Array.from({ length: 50 }, (_, i) => file(i + '.txt', 8 * 1024 * 1024))).length, 50, 'no new arbitrary attachment count or size cap')
for (const ext of ['png','jpg','jpeg','webp','txt','md','csv','json','log','yaml','yml','xml','ini','c','h','cpp','py','js','ts']) assert.equal(prepareAttachmentFiles([file('name.' + ext)]).length, 1)
let clicks = 0
const visible = renderToStaticMarkup(createElement(AssistantAttachmentReadStatus, { reading: true, cancel: () => clicks++ }))
assert(visible.includes('type="button"')); assert(visible.includes('取消读取')); assert(visible.includes('尚未发送')); assert(visible.includes('role="status"')); assert.equal(clicks, 0)
assert.equal(renderToStaticMarkup(createElement(AssistantAttachmentReadStatus, { reading: false, cancel() {} })), '')
console.log('ASSISTANT ATTACHMENT READ OK: metadata preflight/no size cap, cancellable fake FileReader cleanup, sibling abort, atomic draft preservation/order, cancel/new-read/finalizer isolation, unmount/remount, original MIME names and server payload compatibility, production cancel-status SSR; no user files, network, model, device, database or DOM automation')
