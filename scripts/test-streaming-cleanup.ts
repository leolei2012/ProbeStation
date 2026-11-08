import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { Sink } from '../packages/sink/src/index.ts'
import { candidateHistoryXlsx } from './fixtures/history-streaming-candidate.ts'
import { candidateDisconnectSignal } from './fixtures/history-disconnect-candidate.ts'

const names = ['private-cleanup-fault', 'private-repeat-abort', 'public-destroy-before-commit', 'public-destroy-during-commit', 'archive-does-not-drain', 'http-events', 'http-pending-read', 'http-row-disconnect', 'http-complete-buffer-disconnect', 'owned-process-boundary']
const argv = process.argv.slice(2), index = argv.indexOf('--case'), name = index < 0 ? undefined : argv[index + 1]
assert(argv.includes('--synthetic'), 'Explicit --synthetic required')
assert(argv.every((arg, i) => ['--synthetic', '--case'].includes(arg) || index >= 0 && i === index + 1), 'Unknown argument')
assert(!name || names.includes(name) || name === 'boundary-worker', 'Unknown synthetic case')
const start = '2026-11-06T00:00:00Z', end = '2026-11-06T00:01:00Z', base = Date.parse(start)
const row = { ts: start, timestampMs: base, address: 0, area: 'holding-register', rawValue: 7, quality: 'good', batchId: 'synthetic', slaveId: 1 }
const config = { listRegistersByObject: () => [{ id: 1, functionCode: 3, startAddress: 0, dataType: 'uint16', slaveId: 1 }] }
const sink = (rows = [row]) => new Sink({ config, store: { async queryObjectForExport() { return rows } } })
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const raw = () => ({ request: Object.assign(new EventEmitter(), { complete: true, destroyed: false }), response: Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false }) })
const report = (result: object) => console.log(JSON.stringify({ case: name, ...result }))
if (!name || name === 'owned-process-boundary') {
  for (const item of name ? [name] : names) {
    await new Promise<void>((resolve, reject) => {
      const boundary = item === 'owned-process-boundary', child = spawn(process.execPath, ['--max-old-space-size=256', '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--synthetic', '--case', boundary ? 'boundary-worker' : item], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
      let stdout = '', stderr = '', killed = false
      assert(child.stdout && child.stderr, 'owned test child must expose the requested pipes')
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
      child.on('message', message => { if (boundary && (message as any).ready) { killed = child.kill(); if (!killed) child.send({ stop: true }) } })
      const timer = setTimeout(() => { child.kill(); reject(new Error('Owned synthetic child exceeded 10 seconds: ' + item)) }, 10000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        try {
          if (boundary) { assert(killed, 'public kill of the owned worker did not succeed'); assert.notEqual(code, 0); assert.equal(stdout, ''); console.log(JSON.stringify({ case: item, ownedChildClosed: true, killAccepted: true, fileReturned: false, exitCode: code, exitSignal: signal })) }
          else { assert.equal(code, 0, JSON.stringify({ item, code, stdout, stderr })); console.log(stdout.trim()) }
          resolve()
        } catch (error) { reject(error) }
      })
    })
  }
  console.log(JSON.stringify({ complete: true, cases: name ? 1 : names.length }))
} else if (name === 'boundary-worker') {
  const controller = new AbortController(); let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  process.on('message', message => { if ((message as any).stop) { controller.abort(); release() } })
  try { await candidateHistoryXlsx(sink(), [1, start, end], { signal: controller.signal, beforeCommit: async () => { process.send?.({ ready: true }); await gate } }); throw new Error('Worker must never return a file') }
  finally { process.disconnect?.() }
} else if (name === 'private-cleanup-fault' || name === 'private-repeat-abort') {
  const Original = ExcelJS.stream.xlsx.WorkbookWriter, primary = new Error('synthetic primary'), cleanup = new Error('synthetic private abort'), streamFailure = new Error('synthetic stream destroy')
  for (const doubleFault of name === 'private-cleanup-fault' ? [false, true] : [false]) {
    let stream: any, restoreDestroy: any, realAbort: any, aborts = 0, observed: any; const cleanups: any[] = []
    ;(ExcelJS.stream.xlsx as any).WorkbookWriter = class extends Original { constructor(options: any) { super(options); stream = options.stream; restoreDestroy = stream.destroy.bind(stream); realAbort = (this as any).zip.abort.bind((this as any).zip); (this as any).zip.abort = () => { aborts++; if (name === 'private-cleanup-fault') throw cleanup; return realAbort() }; if (doubleFault) stream.destroy = () => { throw streamFailure } } }
    try {
      const controller = new AbortController()
      try { await candidateHistoryXlsx(sink(), [1, start, end], { signal: controller.signal, onRow() { if (name === 'private-cleanup-fault') throw primary; controller.abort() }, onCleanup: state => cleanups.push(state) }) } catch (error) { observed = error }
      if (name === 'private-cleanup-fault') { assert(observed instanceof AggregateError); assert(observed.errors.includes(primary) && observed.errors.includes(cleanup)); if (doubleFault) assert(observed.errors.includes(streamFailure)); else assert(stream.destroyed) }
      else { assert.equal(observed?.name, 'AbortError'); assert(stream.destroyed) }
      assert.equal(aborts, 1); assert.equal(cleanups.length, 1); assert.equal(cleanups[0].returnedBytes, 0)
      report({ doubleFault, aborts, originalPreserved: name === 'private-cleanup-fault' ? observed.errors.includes(primary) : true, streamDestroyed: stream.destroyed, returnedBytes: cleanups[0].returnedBytes })
    } finally { (ExcelJS.stream.xlsx as any).WorkbookWriter = Original; stream.destroy = restoreDestroy; realAbort?.(); restoreDestroy?.() }
  }
} else if (name.startsWith('public-destroy')) {
  let stream!: Writable, writer: any, state = 'pending', chunks = 0
  const reason = new Error('synthetic public stream failure')
  stream = new Writable({ write(_chunk, _encoding, done) { chunks++; done(); if (name === 'public-destroy-during-commit' && chunks === 1) stream.destroy(reason) } }); stream.on('error', () => {})
  writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream }); writer.zip.on('error', () => {})
  try {
    const sheet = writer.addWorksheet('data'); sheet.addRow(['synthetic']).commit(); sheet.commit()
    if (name === 'public-destroy-before-commit') stream.destroy()
    void writer.commit().then(() => { state = 'fulfilled' }, () => { state = 'rejected' })
    await pause(75); assert(stream.destroyed); if (name === 'public-destroy-before-commit') assert.equal(state, 'pending')
    report({ publicOutputDestroyed: stream.destroyed, commitStateAfter75ms: state, archiveDestroyed: writer.zip.destroyed, archiveReadableEnded: writer.zip.readableEnded, chunks, fileReturned: false })
  } finally { writer.zip.abort(); stream.destroy() }
} else if (name === 'archive-does-not-drain') {
  let entered!: () => void, started = false
  const waiting = new Promise<void>(resolve => { entered = resolve }), source = new Readable({ read() { if (!started) { started = true; this.push(Buffer.from('synthetic partial input')); entered() } } }), destination = new Writable({ write(_chunk, _encoding, done) { done() } })
  const writer: any = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: destination }); writer.zip.on('error', () => {}); destination.on('error', () => {})
  try { writer.zip.append(source, { name: 'synthetic-unfinished-source' }); await waiting; writer.zip.abort(); await pause(20); assert.equal(source.destroyed, false); assert.equal(source.readableEnded, false); report({ abortReturned: true, activeSourceDestroyed: source.destroyed, activeSourceEnded: source.readableEnded }) }
  finally { source.destroy(); writer.zip.destroy(); destination.destroy() }
} else if (name === 'http-events') {
  for (const scenario of ['complete-request-close', 'normal-response-finish', 'incomplete-request-close', 'response-close', 'already-disconnected']) {
    const { request, response } = raw(); request.on('close', () => {}); response.on('close', () => {}); response.on('finish', () => {})
    if (scenario === 'already-disconnected') response.destroyed = true
    const binding = candidateDisconnectSignal(request, response)
    if (scenario === 'complete-request-close') { request.destroyed = true; request.emit('close'); assert.equal(binding.signal.aborted, false) }
    if (scenario === 'normal-response-finish') { response.writableFinished = true; response.emit('finish'); response.destroyed = true; response.emit('close'); assert.equal(binding.signal.aborted, false) }
    if (scenario === 'incomplete-request-close') { request.complete = false; request.emit('close'); assert(binding.signal.aborted) }
    if (scenario === 'response-close') { response.emit('close'); assert(binding.signal.aborted) }
    if (scenario === 'already-disconnected') assert(binding.signal.aborted)
    binding.dispose(); binding.dispose(); assert.equal(request.listenerCount('close'), 1); assert.equal(response.listenerCount('close'), 1); assert.equal(response.listenerCount('finish'), 1)
  }
  report({ scenarios: 5, normalCompletionNotAborted: true, ownedListenersRemoved: true })
} else if (name === 'http-pending-read') {
  const { request, response } = raw(), binding = candidateDisconnectSignal(request, response)
  let release!: () => void, entered!: () => void, state = 'pending'
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve }), source = new Sink({ config, store: { async queryObjectForExport() { entered(); await gate; return [row] } } })
  const pending = candidateHistoryXlsx(source, [1, start, end], { signal: binding.signal }).then(() => { state = 'returned' }, error => { assert.equal(error.name, 'AbortError'); state = 'rejected' })
  try { await waiting; response.destroyed = true; response.emit('close'); await pause(10); assert.equal(state, 'pending'); release(); await pending; assert.equal(state, 'rejected'); report({ signalAborted: true, pendingUntilReadReleased: true, fileReturned: false }) }
  finally { release(); await pending; binding.dispose() }
} else {
  const { request, response } = raw(), binding = candidateDisconnectSignal(request, response), cleanups: any[] = []; let delivered = false, seen = 0, observed: any
  try {
    const rows = Array.from({ length: name === 'http-row-disconnect' ? 1000 : 1 }, (_, i) => ({ ...row, ts: new Date(base + i).toISOString(), timestampMs: base + i }))
    const output = await candidateHistoryXlsx(sink(rows), [1, start, end], { signal: binding.signal, onRow(count) { seen = count; if (name === 'http-row-disconnect' && count === 1) setImmediate(() => { response.destroyed = true; response.emit('close') }) }, onPhase(phase) { if (name === 'http-complete-buffer-disconnect' && phase === 'output') { response.destroyed = true; response.emit('close') } }, onCleanup: state => cleanups.push(state) })
    binding.signal.throwIfAborted(); assert.equal(response.destroyed, false); assert(output.length); delivered = true
  } catch (error) { observed = error }
  finally { binding.dispose() }
  assert.equal(observed?.name, 'AbortError'); assert.equal(delivered, false); assert.equal(request.listenerCount('close'), 0); assert.equal(response.listenerCount('close'), 0); assert.equal(response.listenerCount('finish'), 0)
  if (name === 'http-row-disconnect') { assert(seen < 1000); assert.equal(cleanups[0].returnedBytes, 0); assert(cleanups[0].destroyed) } else assert(cleanups[0].returnedBytes > 0)
  report({ delivered, generatedCompleteBuffer: cleanups[0].returnedBytes > 0, rowsSeen: seen, ownedListenersRemoved: true })
}
