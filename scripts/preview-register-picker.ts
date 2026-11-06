import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static manual preview only. No app/config/store imports, sockets or database paths.
const root = fileURLToPath(new URL('../', import.meta.url)), output = resolve(root, 'output/playwright/register-picker-preview.html')
const marker = 'data-probestation-preview="register-picker"'
try {
  const existing = await readFile(output, 'utf8')
  if (!existing.includes(marker)) throw new Error('预览目标已有其他文件，已保留：' + output)
} catch (error: any) { if (error.code !== 'ENOENT') throw error }
const result = await build({ entryPoints: [resolve(root, 'scripts/fixtures/register-picker-preview.tsx')], bundle: true, write: false,
  outdir: resolve(root, 'output/playwright/assets'), entryNames: 'picker', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const jsFile = result.outputFiles?.find(file => file.path.endsWith('.js')), cssFile = result.outputFiles?.find(file => file.path.endsWith('.css'))
if (!jsFile || !cssFile) throw new Error('预览缺少完整JS/CSS输出，未覆盖旧预览。')
const js = jsFile.text.replace(/<\/script/gi, '<\\/script')
const css = cssFile.text.replace(/<\/style/gi, '<\\/style')
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"
const html = `<!doctype html><html lang="zh-CN" ${marker}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>ProbeStation 纯 mock 选点验收</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
await mkdir(resolve(root, 'output/playwright'), { recursive: true }); await writeFile(output, html, 'utf8')
console.log('已生成纯静态mock预览，请用浏览器手动打开：' + output)
console.log('未启动服务，不读写数据库，不连接设备；所有资源内联，页面禁止网络连接。')
