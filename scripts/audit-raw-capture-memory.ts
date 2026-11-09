import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Explicit, bounded synthetic scenarios only. Never mounts App or opens a device/database.
const shapes = [{ count: 20, bytes: 4096 }, { count: 200, bytes: 4096 }, { count: 200, bytes: 16384 }, { count: 2000, bytes: 256 }]
const cases = shapes.flatMap(shape => (['all', 'last20'] as const).map(mode => ({ ...shape, mode, key: `${shape.count}x${shape.bytes}-${mode}` })))
const args = process.argv.slice(2), position = args.indexOf('--case'), selected = position < 0 ? undefined : cases.find(item => item.key === args[position + 1])
assert(args.includes('--synthetic') && args.every((arg, index) => ['--synthetic', '--matrix', '--case'].includes(arg) || position >= 0 && index === position + 1), 'Only fixed synthetic scenarios are supported')
assert(position < 0 || selected, 'Unknown synthetic case'); assert(!!selected !== args.includes('--matrix'), 'Choose --matrix or --case NAME')
if (!selected) {
  for (let repeat = 1; repeat <= 2; repeat++) for (const item of cases) {
    const result = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=256', '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--synthetic', '--case', item.key], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16000) child.kill() }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
      const timeout = setTimeout(() => { timedOut = true; child.kill() }, 20000)
      child.on('error', error => { clearTimeout(timeout); reject(error) })
      child.on('close', code => { clearTimeout(timeout); if (code !== 0 || timedOut) reject(new Error(`Synthetic child failed ${item.key}: ${code}, timeout=${timedOut}, ${stderr}`)); else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } } })
    })
    console.log(JSON.stringify({ repeat, ...result }))
  }
} else {
  const [{ default: ts }, React, { renderToStaticMarkup }, { communicationScope }, { parseRawFrames }] = await Promise.all([import('typescript'), import('react'), import('react-dom/server'), import('../apps/web/src/communication-summary.ts'), import('../apps/web/src/raw-frames-read.ts')])
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const view = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RawDataView')!
  const nodes: any[] = []; const visit = (node: any) => { nodes.push(node); ts.forEachChild(node, visit) }; visit(view)
  const map = nodes.find(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map')
  assert(map?.arguments[0], 'Find actual raw capture row renderer without evaluating App')
  const renderRow = Function('React', 'dir', ts.transpile(`return (${map.arguments[0].getText(source)})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }))(React, (direction: string) => direction === 'tx' ? 'TX' : 'RX')
  const declared = (name: string) => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === name)?.initializer
  const selectFrames = declared('pageFrames') ? Function('visibleFrames', 'capturePage', 'pageOwner', ts.transpile(['pageIndex', 'pageEnd', 'pageStart', 'pageFrames'].map(name => `const ${name} = (${declared(name).getText(source)});`).join('\n') + '\nreturn pageFrames;', { target: ts.ScriptTarget.ES2022 })) : null
  const checkpoints: Record<string, { rss: number; heap: number }> = {}, sample = (stage: string) => { const memory = process.memoryUsage(); checkpoints[stage] = { rss: memory.rss, heap: memory.heapUsed }; assert(memory.rss < 512 * 1024 * 1024, 'Synthetic RSS guard exceeded') }
  sample('base'); const started = performance.now()
  const raw = Array.from({ length: selected.count }, (_, index) => {
    const data = Buffer.alloc(selected.bytes, index % 256); data.writeUInt32LE(index); data[6] = 1; data[7] = 3
    return { id: index + 1, timestamp: '2026-11-09T00:00:00.123Z', transport: 'tcp', direction: 'rx', hex: data.toString('hex').toUpperCase(), byteLength: data.length, slaveId: 1, functionCode: 3, isException: false, deviceId: 1, channelKey: 'tcp:1' }
  })
  const snapshot = parseRawFrames(raw, communicationScope({ id: 1, transport: 'tcp' }), selected.count), originalHex = snapshot.frames.map(frame => frame.hex)
  sample('snapshot'); const parsedAt = performance.now()
  let frames = snapshot.frames, selection = 'all-row baseline'
  if (selected.mode === 'last20') {
    if (selectFrames) {
      frames = selectFrames(snapshot.frames, null, {}); assert.deepEqual(frames, snapshot.frames.slice(-20)); selection = 'actual App page expressions'
    } else { frames = snapshot.frames.slice(-20); selection = 'candidate tail20 only' }
  }
  const rows = frames.map(renderRow); sample('rows'); const rowsAt = performance.now()
  const html = renderToStaticMarkup(React.createElement('div', null, rows)); sample('html'); const finished = performance.now()
  assert.equal(snapshot.frames.length, selected.count); assert.deepEqual(snapshot.frames.map(frame => frame.hex), originalHex)
  const characters = frames.reduce((sum, frame) => sum + frame.byteLength * 3 - 1, 0)
  assert(html.length > characters); assert.equal(rows.length, Math.min(selected.count, selected.mode === 'last20' ? 20 : selected.count))
  const peakRss = process.resourceUsage().maxRSS * 1024; assert(peakRss >= Math.max(...Object.values(checkpoints).map(value => value.rss)))
  console.log(JSON.stringify({ case: selected.key, node: process.version, platform: process.platform, mode: selected.mode, selection, snapshotRecords: snapshot.frames.length, renderedRecords: rows.length, rawBytes: selected.count * selected.bytes, formattedByteCharacters: characters, htmlBytes: Buffer.byteLength(html), prepareMs: parsedAt - started, rowMs: rowsAt - parsedAt, ssrMs: finished - rowsAt, renderMs: finished - parsedAt, peakRssBytes: peakRss, checkpoints, boundary: 'Node SSR and process RSS only; not browser layout, paint, network/backend memory or capacity guarantee' }))
}
