import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Opt-in comparison, fixed synthetic fixtures, no application/database/network entry.
const shapes = [
  { id: 'p1-t1000', points: 1, timestamps: 1000 },
  { id: 'p50-t100', points: 50, timestamps: 100 },
  { id: 'p50-t500', points: 50, timestamps: 500 },
  { id: 'p50-t1000', points: 50, timestamps: 1000 },
  { id: 'p200-t250', points: 200, timestamps: 250 },
  { id: 'p1-t20000', points: 1, timestamps: 20000 },
  { id: 'p50-t500-dense', points: 50, timestamps: 500, dense: true },
] as const
const cases = shapes.flatMap(shape => (['document', 'candidate'] as const).map(writer => ({ ...shape, writer, key: shape.id + '-' + writer })))
const argv = process.argv.slice(2), index = argv.indexOf('--case'), selected = index < 0 ? undefined : cases.find(item => item.key === argv[index + 1])
assert(argv.includes('--synthetic'), 'Explicit --synthetic required')
assert(argv.every((arg, i) => ['--synthetic', '--matrix', '--case'].includes(arg) || index >= 0 && i === index + 1), 'Unknown argument')
assert(index < 0 || selected, 'Choose a fixed synthetic case')
assert(!!selected !== argv.includes('--matrix'), 'Choose exactly one mode')
const rssGuard = 384 * 1048576
if (!selected) {
  let count = 0
  for (let repeat = 1; repeat <= 2; repeat++) for (const item of cases) {
    const report = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=384', '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--synthetic', '--case', item.key], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.on('data', chunk => { stdout += chunk; assert(stdout.length < 64000) }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 40000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); if (code !== 0 || timedOut) reject(new Error(JSON.stringify({ case: item.key, code, timedOut, stdout, stderr }))); else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } } })
    })
    count++; console.log(JSON.stringify({ ...report, repeat }))
  }
  console.log(JSON.stringify({ complete: true, cases: count, repeats: 2, rssGuardBytes: rssGuard, timeoutMs: 40000 }))
} else {
  // Import identical modules for both variants to keep the dependency baseline comparable.
  const { Sink } = await import('../packages/sink/src/index.ts'), { default: ExcelJS } = await import('exceljs'), { candidateHistoryXlsx } = await import('./fixtures/history-streaming-candidate.ts')
  const checkpoints: any[] = []; let maxObservedHeap = 0
  const sample = (phase?: string) => { const memory = process.memoryUsage(); maxObservedHeap = Math.max(maxObservedHeap, memory.heapUsed); if (phase) checkpoints.push({ phase, ...memory }); if (process.resourceUsage().maxRSS * 1024 > rssGuard) { console.log(JSON.stringify({ guarded: true, case: selected.key, checkpoints })); process.exit(2) } }
  sample('imports')
  const base = Date.parse('2026-11-06T00:00:00Z'), dense = 'dense' in selected && selected.dense
  const registers = Array.from({ length: selected.points }, (_, i) => ({ id: i + 1, groupId: 1, functionCode: 3, startAddress: i, dataType: 'uint16', alias: 'p' + i }))
  const rows = Array.from({ length: selected.timestamps }, (_, t) => Array.from({ length: dense ? selected.points : 1 }, (_, p) => ({ timestampMs: base + t, ts: new Date(base + t).toISOString(), batchId: 'synthetic-' + t, area: 'holding-register', slaveId: 1, address: dense ? p : t % selected.points, rawValue: 7, quality: 'good' }))).flat()
  assert(rows.length <= 25000); assert((1 + 3 * selected.points) * (selected.timestamps + 1) <= 151151)
  sample('fixture')
  const sink = new Sink({ config: { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => [{ id: 1, slaveId: 1 }], listRegistersByObject: () => registers }, store: { async queryObjectForExport() { return rows } } }), collect = (sink as any).collect.bind(sink)
  ;(sink as any).collect = async (...args: any[]) => { const result = await collect(...args); sample('afterCollect'); return result }
  const descriptor = Object.getOwnPropertyDescriptor(ExcelJS.Workbook.prototype, 'xlsx')!
  Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', { ...descriptor, get(this: any) { const writer = descriptor.get!.call(this), write = writer.writeBuffer.bind(writer); writer.writeBuffer = async (...args: any[]) => { sample('beforeWriteBuffer'); const output = await write(...args); sample('afterWriteBuffer'); return output }; return writer } })
  const began = performance.now(); let firstTimerMs = 0
  const timerDone = new Promise<void>(resolve => setTimeout(() => { firstTimerMs = performance.now() - began; resolve() }, 0)), interval = setInterval(() => sample(), 20); interval.unref()
  try {
    const args: [number, string, string] = [1, new Date(base).toISOString(), new Date(base + selected.timestamps).toISOString()]
    const output = selected.writer === 'document' ? await sink.exportXlsx(...args) : await candidateHistoryXlsx(sink, args, { onPhase: phase => { if (phase !== 'afterCollect') sample(phase) } })
    const elapsedMs = performance.now() - began; sample('outputComplete'); assert.equal(output.subarray(0, 2).toString(), 'PK')
    const peakRssBytes = process.resourceUsage().maxRSS * 1024; await timerDone
    console.log(JSON.stringify({ case: selected.key, writer: selected.writer, points: selected.points, timestamps: selected.timestamps, rawRows: rows.length, cells: (1 + selected.points * 3) * (selected.timestamps + 1), node: process.version, platform: process.platform, elapsedMs, firstTimerMs, outputBytes: output.length, peakRssBytes, maxObservedHeap, checkpoints }))
  } finally { clearInterval(interval); Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', descriptor) }
}
