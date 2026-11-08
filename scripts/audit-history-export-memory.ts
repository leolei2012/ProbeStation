import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Opt-in, fixed small synthetic fixtures only. Never imports the application or opens storage.
// Each measured export runs in its own child so GC history from other cases cannot accumulate.
const shapes = [
  { id: 'p1-t1000', points: 1, timestamps: 1000 },
  { id: 'p10-t1000', points: 10, timestamps: 1000 },
  { id: 'p50-t100', points: 50, timestamps: 100 },
  { id: 'p50-t500', points: 50, timestamps: 500 },
  { id: 'p50-t1000', points: 50, timestamps: 1000 },
  { id: 'p100-t500', points: 100, timestamps: 500 },
  { id: 'p200-t250', points: 200, timestamps: 250 },
  { id: 'p1-t20000', points: 1, timestamps: 20000 },
  { id: 'p50-t500-dense', points: 50, timestamps: 500, dense: true },
] as const
const cases = shapes.flatMap(shape => (['csv', 'xlsx'] as const).map(format => ({ ...shape, format, key: shape.id + '-' + format })))
const argv = process.argv.slice(2), index = argv.indexOf('--case'), selected = index < 0 ? undefined : cases.find(item => item.key === argv[index + 1])
assert(argv.includes('--synthetic'), 'Explicit --synthetic required; no device or database mode exists')
assert(argv.every((arg, i) => ['--synthetic', '--matrix', '--case'].includes(arg) || (index >= 0 && i === index + 1)), 'Unknown argument')
assert(index < 0 || selected, 'Choose a fixed case: ' + cases.map(item => item.key).join(', '))
assert((!!selected) !== argv.includes('--matrix'), 'Choose exactly one of --matrix or --case NAME')
const rssGuard = 384 * 1024 * 1024, timeoutMs = 40_000

if (!selected) {
  const results: any[] = []
  for (let repeat = 1; repeat <= 2; repeat++) for (const item of cases) {
    const report = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=384', '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--synthetic', '--case', item.key], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.on('data', chunk => { stdout += chunk; assert(stdout.length < 64_000, 'unexpected audit output') })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0 || timedOut) return reject(new Error(JSON.stringify({ case: item.key, repeat, code, timedOut, stdout, stderr })))
        try { resolve({ ...JSON.parse(stdout), repeat }) } catch (error) { reject(error) }
      })
    })
    results.push(report); console.log(JSON.stringify(report))
  }
  console.log(JSON.stringify({ complete: true, cases: results.length, fixedFixtureCount: cases.length, repeats: 2, rssGuardBytes: rssGuard, timeoutMs }))
} else {
  const { Sink } = await import('../packages/sink/src/index.ts'), { default: ExcelJS } = await import('exceljs')
  const checkpoints: Array<{ phase: string; rss: number; heapUsed: number; external: number; arrayBuffers: number }> = []
  let maxObservedHeap = 0, maxObservedExternal = 0, observedRss = 0, ticks = 0
  const sample = (phase?: string) => {
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
    maxObservedHeap = Math.max(maxObservedHeap, heapUsed); maxObservedExternal = Math.max(maxObservedExternal, external); observedRss = Math.max(observedRss, rss)
    if (phase) checkpoints.push({ phase, rss, heapUsed, external, arrayBuffers })
    // A checkpoint/async sampling guard, not an OS memory quota or protection against one large allocation.
    if (rss > rssGuard || process.resourceUsage().maxRSS * 1024 > rssGuard) { console.log(JSON.stringify({ case: selected.key, guarded: true, rss, phase, checkpoints })); process.exit(2) }
  }
  sample('imports')
  const timestamp = Date.parse('2026-11-06T00:00:00Z'), dense = 'dense' in selected && selected.dense
  const definitions = Array.from({ length: selected.points }, (_, i) => ({ id: i + 1, groupId: 1, startAddress: i, functionCode: 3, dataType: 'uint16', alias: 'p' + i }))
  const rows = Array.from({ length: selected.timestamps }, (_, t) => {
    const timestampMs = timestamp + t, ts = new Date(timestampMs).toISOString(), batchId = 'synthetic-' + t
    return Array.from({ length: dense ? selected.points : 1 }, (_, p) => ({ timestampMs, ts, batchId, area: 'holding-register', slaveId: 1, address: dense ? p : t % selected.points, rawValue: 7, quality: 'good' }))
  }).flat()
  assert(rows.length <= 25_000); assert((1 + selected.points * 3) * (selected.timestamps + 1) <= 151_151)
  sample('fixture')
  const sink = new Sink({ config: { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => [{ id: 1, slaveId: 1 }], listRegistersByObject: () => definitions }, store: { async queryObjectForExport() { return rows } } })
  const collect = (sink as any).collect.bind(sink)
  ;(sink as any).collect = async (...args: any[]) => { const result = await collect(...args); sample('afterCollect'); return result }
  let dimensions: { rows: number; columns: number } | undefined
  const descriptor = Object.getOwnPropertyDescriptor(ExcelJS.Workbook.prototype, 'xlsx')!
  Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', { ...descriptor, get(this: any) {
    const writer = descriptor.get!.call(this), write = writer.writeBuffer.bind(writer)
    writer.writeBuffer = async (...args: any[]) => {
      const data = this.getWorksheet('data'); dimensions = { rows: data.rowCount, columns: data.columnCount }; sample('beforeWriteBuffer')
      const output = await write(...args); sample('afterWriteBuffer'); return output
    }
    return writer
  } })
  let firstTimerMs = 0
  const began = performance.now(), timerDone = new Promise<void>(resolve => setTimeout(() => { firstTimerMs = performance.now() - began; resolve() }, 0))
  const interval = setInterval(() => { ticks++; sample() }, 20); interval.unref()
  try {
    const output = selected.format === 'csv' ? await sink.exportCsv(1, new Date(timestamp).toISOString(), new Date(timestamp + selected.timestamps).toISOString()) : await sink.exportXlsx(1, new Date(timestamp).toISOString(), new Date(timestamp + selected.timestamps).toISOString())
    const elapsedMs = performance.now() - began; sample('output')
    const peakRssBytes = process.resourceUsage().maxRSS * 1024
    assert(peakRssBytes >= observedRss, 'native maxRSS must cover observed working sets on this platform')
    const outputBytes = typeof output === 'string' ? Buffer.byteLength(output) : output.byteLength
    if (typeof output === 'string') dimensions = { rows: output.split('\n').length, columns: output.slice(0, output.indexOf('\n')).split(',').length }
    else assert.equal(output.subarray(0, 2).toString(), 'PK')
    assert.deepEqual(dimensions, { rows: selected.timestamps + 1, columns: 1 + selected.points * 3 })
    await timerDone
    console.log(JSON.stringify({ case: selected.key, node: process.version, platform: process.platform, format: selected.format, points: selected.points, timestamps: selected.timestamps, rawRows: rows.length, dense, outputCells: dimensions.rows * dimensions.columns, outputBytes, elapsedMs, firstTimerMs, peakRssBytes, maxObservedHeap, maxObservedExternal, sampledTicks: ticks, checkpoints }))
  } finally { clearInterval(interval); Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', descriptor) }
}
