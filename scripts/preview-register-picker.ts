import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static manual preview only. No app/config/store imports, sockets or database paths.
const args = process.argv.slice(2)
const previews = new Map<string, readonly [string, string]>([['', ['register-picker', '选点']], ['--settings', ['point-settings', '点位设置']], ['--comparison', ['history-comparison', '历史两点对比']], ['--diagnostics', ['point-diagnostics', '点表检查']], ['--backup', ['config-backup', '配置恢复']], ['--live-filter', ['live-point-filter', '实时点位筛选']], ['--markdown', ['assistant-markdown', '助手富文本加载']], ['--time-range', ['history-time-range', '历史时间输入']], ['--query-memory', ['history-query-memory', '本页暂存查询']], ['--alarm-rules', ['alarm-rule-read', '告警规则读取']], ['--persistence', ['persistence-status', '采样落盘']], ['--retention', ['retention-summary', '保留策略']], ['--attachments', ['assistant-attachment-read', '附件读取']], ['--global-retention', ['global-retention', '全局保留策略']], ['--settings-loading', ['settings-loading', '设置延迟加载']], ['--diagnostics-cleanup', ['diagnostics-cleanup', '诊断清空']], ['--raw-frames', ['raw-frames-read', '原始捕获慢读取']], ['--device-issues', ['device-issues', '设备状态提醒']], ['--communication', ['communication-summary', '通信统计']], ['--live-snapshot', ['live-snapshot', '实时观测快照']], ['--logs', ['runtime-logs', '近期日志']], ['--log-cleanup', ['log-cleanup', '日志清理']], ['--alarm-history', ['alarm-history', '告警采样定位']], ['--history-context', ['history-read-context', '历史定义上下文']], ['--curve-selection', ['history-curve-selection', '曲线选点说明']], ['--config-loading', ['config-loading', '配置加载恢复']], ['--device-draft', ['device-draft', '设备草稿关闭保护']]])
const preview = previews.get(args[0] ?? '')
if (args.length > 1 || !preview) throw new Error('只支持无参数、--settings、--comparison、--diagnostics、--backup、--live-filter、--markdown、--time-range、--query-memory、--alarm-rules、--persistence、--retention、--attachments、--global-retention、--settings-loading、--diagnostics-cleanup、--raw-frames、--device-issues、--communication、--live-snapshot、--logs、--log-cleanup、--alarm-history、--history-context、--curve-selection、--config-loading 或 --device-draft；不会读取配置或数据库路径。')
const [kind, title] = preview
const root = fileURLToPath(new URL('../', import.meta.url)), output = resolve(root, `output/playwright/${kind}-preview.html`)
const marker = `data-probestation-preview="${kind}"`
try {
  const existing = await readFile(output, 'utf8')
  if (!existing.includes(marker)) throw new Error('预览目标已有其他文件，已保留：' + output)
} catch (error: any) { if (error.code !== 'ENOENT') throw error }
const result = await build({ entryPoints: [resolve(root, `scripts/fixtures/${kind}-preview.tsx`)], bundle: true, write: false,
  outdir: resolve(root, 'output/playwright/assets'), entryNames: 'picker', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const jsFile = result.outputFiles?.find(file => file.path.endsWith('.js')), cssFile = result.outputFiles?.find(file => file.path.endsWith('.css'))
if (!jsFile || !cssFile) throw new Error('预览缺少完整JS/CSS输出，未覆盖旧预览。')
const js = jsFile.text.replace(/<\/script/gi, '<\\/script')
const css = cssFile.text.replace(/<\/style/gi, '<\\/style')
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"
const html = `<!doctype html><html lang="zh-CN" ${marker}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>ProbeStation 纯 mock ${title}验收</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
await mkdir(resolve(root, 'output/playwright'), { recursive: true }); await writeFile(output, html, 'utf8')
console.log('已生成纯静态mock预览，请用浏览器手动打开：' + output)
console.log('未启动服务，不读写数据库，不连接设备；所有资源内联，页面禁止网络连接。')
