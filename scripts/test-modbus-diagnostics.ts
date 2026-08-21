import { ModbusDiagnostics } from '../packages/modbus/src/diagnostics.ts'

const diagnostics = new ModbusDiagnostics('rtu', 3, { channelKey: 'rtu:COM_TEST' })
for (let i = 1; i <= 5; i++) diagnostics.recordFrame(i % 2 ? 'tx' : 'rx', Buffer.from([i, 3, 0, 0]))
diagnostics.recordSuccess(10)
diagnostics.recordSuccess(20)
diagnostics.recordError(new Error('Timeout'), 30)

const frames = diagnostics.getFrames(20)
if (frames.length !== 3 || frames[0].slaveId !== 3 || frames[2].slaveId !== 5) throw new Error('bounded frame buffer failed')
if (diagnostics.getFrames(0).length !== 0) throw new Error('zero frame limit failed')

const snapshot = diagnostics.snapshot()
if (snapshot.scope !== 'channel' || snapshot.successCount !== 2 || snapshot.errorCount !== 1) throw new Error('request counters failed')
if (snapshot.timeoutCount !== 1 || snapshot.consecutiveErrors !== 1) throw new Error('error counters failed')
if (snapshot.averageResponseMs !== 20 || snapshot.recentErrorRate !== 1 / 3) throw new Error('latency/error rate failed')

diagnostics.clear()
const cleared = diagnostics.snapshot()
if (cleared.bufferedFrames !== 0 || cleared.successCount !== 0 || cleared.errorCount !== 0) throw new Error('clear failed')
console.log('MODBUS DIAGNOSTICS TEST OK')
