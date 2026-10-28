/** Pure fixture preview: serves the production UI and synthetic JSON only.
 * Never imports the application bootstrap, databases, drivers, poller or AI providers.
 * Build first: npm run build:web; run: npx tsx scripts/preview-history-mock.ts
 * --file generates a self-contained offline HTML preview under .npm-cache/probe-ui.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist')
const fileOnly = process.argv.includes('--file')
const port = Number(fileOnly ? 4180 : process.argv[2] ?? 4180)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
const device = { id: 1, name: '离线 MOCK · 无硬件', ip: 'mock.invalid', port: 502, mode: 'master', isActive: 0, transport: 'tcp', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000, connected: false }
const group = { id: 1, name: '模拟观测组', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1, isActive: 1 }
const reg = { id: 1, groupId: 1, objectId: 1, alias: '长标签压力测试_' + '温度传感器采样质量说明'.repeat(10), functionCode: 3, startAddress: 0, dataType: 'uint16', unit: '°C', factor: 0.1, offset: 0, enumJson: null }
const controls = `<style>#mock-controls{height:44px;display:flex;align-items:center;gap:8px;padding:4px 12px;overflow:auto;background:#fff3c4;color:#222;font:13px sans-serif;white-space:nowrap}#mock-controls button{padding:4px 8px}#root{height:calc(100vh - 44px)}</style>
<div id="mock-controls" aria-label="离线场景控制"><strong>纯 MOCK</strong>${['normal','empty','invalid','error','recovered'].map(name => `<button type="button" data-scenario="${name}">${name}</button>`).join('')}<output id="mock-state">normal</output></div>
<script>
window.probeMockScenario='normal';
document.querySelectorAll('[data-scenario]').forEach(button=>button.onclick=()=>{window.probeMockScenario=button.dataset.scenario;document.getElementById('mock-state').textContent=button.dataset.scenario});
const originalFetch=window.fetch.bind(window);
window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin&&url.pathname.startsWith('/api/')){const headers=new Headers(init?.headers);headers.set('x-mock-scenario',window.probeMockScenario);return originalFetch(input,{...init,headers})}throw new Error('Fixture blocks non-API fetch')};
</script>`
function fixture(url: URL, scenario: unknown) {
    const json = (body: unknown, status = 200) => ({ body, status })
    if (url.pathname === '/api/monitor_objects') return json([device])
    if (url.pathname === '/api/monitor_objects/1/groups') return json([group])
    if (url.pathname === '/api/groups/1/registers') return json([reg])
    if (url.pathname === '/api/monitor_objects/1/latest') return json({})
    if (url.pathname === '/api/rules') return json([])
    if (url.pathname === '/api/ai/issues') return json({ issues: [] })
    if (url.pathname === '/api/ai/settings') return json({ provider: 'custom', model: '', baseUrl: '', hasKey: false })
    if (url.pathname === '/api/ai/providers') return json({ providers: [], configured: [] })
    if (url.pathname === '/api/ai/sessions') return json([])
    if (url.pathname === '/api/data/object/page') return json({ points: [], total: 0 })
    if (url.pathname === '/api/data/object/series') {
      if (scenario === 'error') return json({ error: 'MOCK 查询失败：可切换 recovered 后重试' }, 503)
      const end = Date.parse(url.searchParams.get('end')!), start = Date.parse(url.searchParams.get('start')!)
      const count = scenario === 'empty' ? 0 : 1000
      const valid = scenario === 'invalid' ? 0 : scenario === 'normal' ? 990 : count
      const values = scenario === 'invalid' ? [null, null, null] : scenario === 'normal' ? [10, 20, null] : [10, 20, 30]
      const samples = count ? values.map((value, index) => [start + (end - start) * (index + 1) / 4, value]) : []
      return json({ series: [{ id: 1, samples, gapMs: end - start, summary: { sourceSamples: count, validSamples: valid, invalidSamples: count - valid } }], sourceSamples: count, displayedSamples: samples.length, downsampled: count > samples.length, complete: true })
    }
    return json({ error: 'Unknown fixture route: ' + url.pathname }, 404)
}
let html = readFileSync(resolve(root, 'index.html'), 'utf8').replace('<body>', '<body>' + controls)
if (fileOnly) {
  // All assets and responses stay inside this file. CSP prevents actual network output.
  const script = `<script>const __name=(fn)=>fn;const device=${JSON.stringify(device)},group=${JSON.stringify(group)},reg=${JSON.stringify(reg)};const fixture=${fixture.toString()};
window.fetch=async(input,init)=>{if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');const url=new URL(typeof input==='string'?input:input.url,location.href);if(!url.pathname.startsWith('/api/'))throw new Error('Fixture blocks non-API fetch');if(init?.method&&init.method!=='GET')return new Response('{}',{status:405});const result=fixture(url,window.probeMockScenario);return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}})};
window.WebSocket=class { static OPEN=1;readyState=1;constructor(){setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'latest',data:{}})})},0)}send(){this.onmessage?.({data:JSON.stringify({type:'pong'})})}close(){this.readyState=3}};
</script>`
  html = html.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">${script}</head>`)
    .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, (_all, path) => `<script type="module">${readFileSync(resolve(root, '.' + path), 'utf8').replaceAll('</script', '<\\/script')}</script>`)
    .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_all, path) => `<style>${readFileSync(resolve(root, '.' + path), 'utf8')}</style>`)
  const output = resolve(root, '../../../.npm-cache/probe-ui/preview.html')
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, html)
  console.log('PURE MOCK standalone file: ' + output)
} else {
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
  if (req.method !== 'GET') { json({ error: 'Mock preview is read-only' }, 405); return }
  if (url.pathname.startsWith('/api/')) { const result = fixture(url, req.headers['x-mock-scenario']); json(result.body, result.status); return }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
  try {
    const path = resolve(root, '.' + decodeURIComponent(url.pathname))
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return }
    const content = readFileSync(path)
    res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream' })
    res.end(content)
  } catch { res.writeHead(404); res.end() }
})
server.on('upgrade', (_req, socket) => socket.destroy())
server.listen(port, '127.0.0.1', () => console.log(`PURE MOCK preview http://127.0.0.1:${port}; no hardware or provider services loaded`))
}
