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
const renderer = 'src/AssistantMarkdown.tsx', settings = 'src/SettingsModal.tsx', entry = 'index.html'
assert.equal(manifest[entry]?.isEntry, true, 'missing frontend entry; run npm run build:web')
assert.equal(manifest[renderer]?.isDynamicEntry, true, 'Markdown must remain a separate deferred entry')
assert.equal(manifest[settings]?.isDynamicEntry, true, 'Settings must remain a separate deferred entry')
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
assert.ok(!startup.has(renderer), 'Markdown renderer entered the startup graph')
assert.ok(!startup.has(settings), 'Settings entered the startup graph')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(renderer)), 'renderer is not reachable through a dynamic import')
assert.ok([...startup].some(key => manifest[key].dynamicImports?.includes(settings)), 'settings is not reachable through a dynamic import')
const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
assert.ok(html.includes('src="/' + manifest[entry].file + '"'))
assert.ok(!html.includes(manifest[renderer].file), 'HTML eagerly references the renderer')
assert.ok(!html.includes(manifest[settings].file), 'HTML eagerly references settings')
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
const settingsSize = sizes(new Set([...closure(settings)].filter(key => !startup.has(key))))
assert.ok(initialSize.bytes < 500000, 'Total statically required startup JS exceeds the 500 kB budget; splitting filenames alone is not sufficient')

// Source-level guard: a tiny dynamic wrapper must not hide a static import of the heavy parser elsewhere.
const graph = await build({ absWorkingDir: root, entryPoints: ['apps/web/src/main.tsx'], bundle: true, write: false, outdir: '.npm-cache/web-bundle-audit', format: 'esm', jsx: 'automatic', target: 'es2022', metafile: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const inputs = graph.metafile!.inputs, visited = new Set<string>()
const deferredSettings = new Set(['SettingsModal', 'GlobalRetentionSettings', 'AssistantSettings', 'ConfigBackupSettings', 'RuntimeLogs', 'LogCleanupDialog'].map(name => 'apps/web/src/' + name + '.tsx'))
function walkSource(key: string) {
  if (visited.has(key)) return
  assert.ok(inputs[key], 'missing source dependency'); visited.add(key)
  assert.ok(!deferredSettings.has(key.replaceAll('\\', '/')), 'Settings-only implementation is statically reachable from startup: ' + key)
  assert.ok(!/node_modules\/(react-markdown|remark-gfm)\//.test(key.replaceAll('\\', '/')), 'Markdown parser is statically reachable from startup')
  for (const dependency of inputs[key].imports) if (!dependency.external && dependency.kind !== 'dynamic-import') walkSource(dependency.path)
}
walkSource('apps/web/src/main.tsx')
console.log(`WEB BUNDLE OK: startup JS ${initialSize.bytes} bytes (${initialSize.gzip} gzip); deferred settings ${settingsSize.bytes} bytes (${settingsSize.gzip} gzip); deferred Markdown ${deferredSize.bytes} bytes (${deferredSize.gzip} gzip); source/manifest/HTML keep settings and parser out of startup; aggregate startup stays below 500 kB. Build sizes, not measured browser latency.`)
