// Audit fixture only. Never imported by the application; no database, listener or device modules.
import process from 'node:process'

const options = JSON.parse(process.argv[2] ?? '{}')
if (!process.send || !['baseline', 'candidate'].includes(options.mode)) throw new Error('owned IPC audit child required')
const allowed = new Set(['SIGINT', 'SIGTERM']), counts = { api: 0, store: 0, config: 0 }, errors = []
const keepAlive = setInterval(() => {}, 1000)
let firstSignal, closing, release
const gate = new Promise(resolve => { release = resolve })
let pendingRows = 2
const report = data => new Promise(resolve => {
  if (!process.connected) return resolve()
  process.send({ ...data, counts: { ...counts }, pendingRows }, () => resolve())
})
const codeFor = signal => signal === 'SIGINT' ? 130 : 143
async function cleanup() {
  await report({ type: 'cleanup-start' })
  for (const name of ['api', 'store', 'config']) {
    await report({ type: 'step', name })
    if (name === 'store') await gate
    counts[name]++
    if (name === options.fail) errors.push(new Error('synthetic ' + name + ' cleanup failure'))
    else if (name === 'store') pendingRows = 0
  }
  await report({ type: 'cleanup-complete', errors: errors.map(error => error.message) })
}
async function finish(signal, primary) {
  if (primary) errors.push(primary)
  await cleanup()
  const code = primary ? 1 : errors.length && options.failureCode === 'one' ? 1 : codeFor(signal)
  await report({ type: 'finished', code, firstSignal: signal, errors: errors.map(error => error.message), primaryPreserved: !primary || errors.includes(primary) })
  clearInterval(keepAlive)
  if (options.restoreDefault && !primary) {
    for (const name of allowed) process.off(name, onSignal)
    process.kill(process.pid, signal) // Self only, inside this owned mock fixture.
    return
  }
  process.exit(code)
}
function onSignal(signal) {
  if (!allowed.has(signal)) throw new Error('unexpected audit signal')
  if (closing) {
    void report({ type: 'duplicate', signal, firstSignal })
    if (options.repeat === 'force') void report({ type: 'forced', firstSignal, signal }).then(() => process.exit(codeFor(firstSignal)))
    return
  }
  firstSignal = signal
  closing = finish(signal)
  void closing.catch(async error => { await report({ type: 'fixture-error', message: error.message }); process.exit(70) })
}
if (options.mode === 'candidate') for (const signal of allowed) process.on(signal, onSignal)
process.on('message', message => {
  if (message.type === 'emit' && allowed.has(message.signal)) {
    const handled = process.emit(message.signal, message.signal)
    void report({ type: 'emitted', signal: message.signal, handled })
  } else if (message.type === 'release') release()
  else if (message.type === 'stop') { clearInterval(keepAlive); process.exit(0) }
  else if (message.type === 'startup-failure') {
    const original = new Error('synthetic startup failure')
    if (options.mode === 'baseline') void report({ type: 'startup-failure', message: original.message }).then(() => process.exit(1))
    else { closing = finish(undefined, original); void closing.catch(() => process.exit(70)) }
  }
})
process.on('disconnect', () => process.exit(0))
await report({ type: 'ready', platform: process.platform, mode: options.mode, signals: [...allowed].filter(signal => process.listenerCount(signal)) })
