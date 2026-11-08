import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

// Inspect only this project's generated frontend and source graph; never execute the app or read a data directory.
if (process.argv.length !== 2) throw new Error('此检查不接受参数；请先运行 npm run build:web。')
const root = fileURLToPath(new URL('../', import.meta.url)), dist = resolve(root, 'apps/web/dist')
let manifest: Record<string, any>
try { manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8')) }
catch { throw new Error('缺少有效前端构建清单，请先运行 npm run build:web。') }
const renderer = 'src/AssistantMarkdown.tsx', settings = 'src/SettingsModal.tsx', diagnostics = 'src/PointDiagnostics.tsx', entry = 'index.html'
const communication = 'src/CommunicationSummaryView.tsx'
const editors = ['src/DeviceModal.tsx', 'src/GroupModal.tsx']
assert.equal(manifest[entry]?.isEntry, true, 'missing frontend entry; run npm run build:web')
assert.equal(manifest[renderer]?.isDynamicEntry, true, 'Markdown must remain a separate deferred entry')
assert.equal(manifest[settings]?.isDynamicEntry, true, 'Settings must remain a separate deferred entry')
assert.equal(manifest[diagnostics]?.isDynamicEntry, true, 'Point diagnostics must remain a separate deferred entry')
assert.equal(manifest[communication]?.isDynamicEntry, true, 'Communication details must remain a separate deferred entry')
function closure(start: string) {
  const visited = new Set<string>()
  const walk = (key: string) => {
    if (visited.has(key)) return
    const node = manifest[key]; assert.ok(node && typeof node.file === 'string', 'missing manifest dependency')
    visited.add(key); assert.ok(node.imports === undefined || Array.isArray(node.imports))
    for (const dependency of node.imports ?? []) { assert.equal(typeof dependency, 'string'); walk(dependency) }
  }
  walk(start); return visited
}
const startup = closure(entry)
for (const editor of editors) {
  assert.equal(manifest[editor]?.isDynamicEntry, true, 'Configuration editor must remain deferred: ' + editor)
  assert.ok(!startup.has(editor), 'Configuration editor entered startup: ' + editor)
  assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(editor)), 'Configuration editor is not dynamically reachable: ' + editor)
}
assert.ok(!startup.has(renderer), 'Markdown renderer entered the startup graph')
assert.ok(!startup.has(settings), 'Settings entered the startup graph')
assert.ok(!startup.has(diagnostics), 'Point diagnostics entered the startup graph')
assert.ok(!startup.has(communication), 'Communication details entered the startup graph')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(communication)), 'communication details are not dynamically reachable')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(diagnostics)), 'point diagnostics is not reachable through a dynamic import')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(renderer)), 'renderer is not reachable through a dynamic import')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(settings)), 'settings is not reachable through a dynamic import')
const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
for (const editor of editors) assert.ok(!html.includes(manifest[editor].file), 'HTML eagerly references configuration editor: ' + editor)
assert.ok(html.includes('src="/' + manifest[entry].file + '"'))
assert.ok(!html.includes(manifest[renderer].file), 'HTML eagerly references the renderer')
assert.ok(!html.includes(manifest[settings].file), 'HTML eagerly references settings')
assert.ok(!html.includes(manifest[diagnostics].file), 'HTML eagerly references point diagnostics')
assert.ok(!html.includes(manifest[communication].file), 'HTML eagerly references communication details')
function asset(file: string) {
  assert.equal(typeof file, 'string'); const full = resolve(dist, file), inside = relative(dist, full)
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && /\.(js|css)$/.test(file), 'asset must stay inside frontend dist')
  return readFileSync(full)
}
function sizes(keys: Set<string>) {
  let bytes = 0, gzip = 0
  for (const file of new Set([...keys].map(key => manifest[key].file))) { const data = asset(file); bytes += data.length; gzip += gzipSync(data).length }
  for (const key of keys) for (const css of manifest[key].css ?? []) asset(css)
  return { bytes, gzip }
}
const deferred = new Set([...closure(renderer)].filter(key => !startup.has(key))), initialSize = sizes(startup), deferredSize = sizes(deferred)
const diagnosticsSize = sizes(new Set([...closure(diagnostics)].filter(key => !startup.has(key))))
const settingsSize = sizes(new Set([...closure(settings)].filter(key => !startup.has(key))))
const communicationSize = sizes(new Set([...closure(communication)].filter(key => !startup.has(key))))
const editorSize = sizes(new Set(editors.flatMap(editor => [...closure(editor)].filter(key => !startup.has(key)))))
const totalSize = sizes(new Set(Object.keys(manifest).filter(key => manifest[key].file.endsWith('.js'))))
assert.ok(initialSize.bytes < 500000, 'Total statically required startup JS exceeds the 500 kB budget; splitting filenames alone is not sufficient')

// Source-level guard: a tiny dynamic wrapper must not hide a static import of the heavy parser elsewhere.
const graph = await build({ absWorkingDir: root, entryPoints: ['apps/web/src/main.tsx'], bundle: true, write: false, outdir: '.npm-cache/web-bundle-audit', format: 'esm', jsx: 'automatic', target: 'es2022', metafile: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const inputs = graph.metafile!.inputs, visited = new Set<string>()
const deferredDiagnostics = new Set(['apps/web/src/PointDiagnostics.tsx', 'apps/web/src/point-diagnostics.ts'])
const deferredSettings = new Set(['SettingsModal', 'GlobalRetentionSettings', 'AssistantSettings', 'ConfigBackupSettings', 'RuntimeLogs', 'LogCleanupDialog'].map(name => 'apps/web/src/' + name + '.tsx'))
function walkSource(key: string) {
  if (visited.has(key)) return
  assert.ok(inputs[key], 'missing source dependency'); visited.add(key)
  assert.ok(!deferredDiagnostics.has(key.replaceAll('\\', '/')), 'Point diagnostics implementation is statically reachable from startup: ' + key)
  assert.ok(!deferredSettings.has(key.replaceAll('\\', '/')), 'Settings-only implementation is statically reachable from startup: ' + key)
  assert.ok(!['DeviceModal', 'GroupModal', 'SerialPortPicker'].some(name => key.replaceAll('\\', '/') === 'apps/web/src/' + name + '.tsx'), 'Configuration editor implementation is statically reachable from startup: ' + key)
  assert.notEqual(key.replaceAll('\\', '/'), 'apps/web/src/CommunicationSummaryView.tsx', 'Communication details are statically reachable from startup')
  assert.ok(!/node_modules\/(react-markdown|remark-gfm)\//.test(key.replaceAll('\\', '/')), 'Markdown parser is statically reachable from startup')
  for (const dependency of inputs[key].imports) if (!dependency.external && dependency.kind !== 'dynamic-import') walkSource(dependency.path)
}
walkSource('apps/web/src/main.tsx')
console.log(`WEB BUNDLE OK: startup JS ${initialSize.bytes} bytes (${initialSize.gzip} gzip); all JS ${totalSize.bytes} bytes (${totalSize.gzip} gzip); deferred editors ${editorSize.bytes} bytes (${editorSize.gzip} gzip); deferred communication ${communicationSize.bytes} bytes (${communicationSize.gzip} gzip); deferred settings ${settingsSize.bytes} bytes (${settingsSize.gzip} gzip); deferred Markdown ${deferredSize.bytes} bytes (${deferredSize.gzip} gzip); deferred diagnostics ${diagnosticsSize.bytes} bytes (${diagnosticsSize.gzip} gzip); source/manifest/HTML keep optional interfaces and parser out of startup; aggregate startup stays below 500 kB. Build sizes, not measured browser latency.`)
