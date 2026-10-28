/** Isolated read-only test edition. Deliberately imports no CLI bootstrap, drivers,
 * poller, slave, MCP server, assistant/provider or real database paths. */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { registerCurve } from '../packages/api/src/curve.ts'
import { registerSerialPorts } from '../packages/api/src/serial-ports.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const controls = `<style>#test-edition{padding:8px 12px;background:#fff3c4;color:#222;font:13px sans-serif;display:flex;gap:8px;align-items:center;flex-wrap:wrap}#root{height:calc(100vh - 64px)}</style><aside id="test-edition"><b>隔离测试版 · 只读合成数据</b><span>选择设备 → 历史。无设备通信/真实库/模型服务；串口清单为后端系统端口，仅枚举。</span><label>查询场景 <select id="test-scenario"><option value="normal">正常/身份样本</option><option value="invalid">全未知</option><option value="empty">空数据</option><option value="error">请求失败</option><option value="recovered">恢复</option></select></label><span>切换后点击历史“查询”；停止：终端 Ctrl+C。</span></aside><script>const control=document.getElementById('test-scenario');control.value=(document.cookie.match(/probeTestScenario=(\\w+)/)||[])[1]||'normal';control.onchange=()=>document.cookie='probeTestScenario='+control.value+'; SameSite=Strict; path=/';</script>`

export async function createOfflineTestApp() {
  const staticDir = join(root, 'apps/web/dist')
  if (!existsSync(join(staticDir, 'index.html'))) throw new Error('请先运行 npm run build:web')
  // Every launch uses a new path. Never accepts a user-supplied database path.
  const dataDir = mkdtempSync(join(tmpdir(), 'probestation-offline-edition-'))
  const cfg = new ConfigStore({ dbPath: join(dataDir, 'config.db') })
  const store = new DuckDBStore({ dbPath: join(dataDir, 'poll.duckdb'), flushIntervalMs: 0, flushBatchSize: 100000, retentionSeconds: 0, retentionCheckMs: 0 })
  const sink = new Sink({ config: cfg, store })
  const device = cfg.createObject('隔离测试 · 仅合成历史', 'mock.invalid', 502)
  cfg.updateObject(device.id, { isActive: 0 })
  const group = cfg.createGroup(device.id, '身份验证示例', 3, 0, 6)
  const reg = cfg.createRegister(group.id, device.id, '32位测试值', 3, 0, 'uint32')
  const wide = cfg.createRegister(group.id, device.id, '长标签_' + '历史批次质量验证'.repeat(12), 3, 2, 'float64-LE')
  const now = Date.now(), start = new Date(now - 600000).toISOString(), end = new Date(now + 1000).toISOString()
  const cases = ['verified', 'unverified', 'mixed', 'missing', 'bad', 'recovered'] as const
  for (let i = 0; i < 60; i++) {
    const kind = cases[Math.floor(i / 10)], timestamp = new Date(now - 590000 + i * 9000).toISOString()
    for (const r of [reg, wide]) {
      const words = encodeRegister(r.dataType, r.id === reg.id ? 65536 + i : 20 + i / 10)
      store.write(words.flatMap((rawValue, index) => kind === 'missing' && index === words.length - 1 ? [] : [{
        objectId: device.id, area: 'holding-register' as const, address: r.startAddress + index, timestamp, rawValue,
        quality: kind === 'bad' && index === 0 ? 'bad' : 'good',
        batchId: kind === 'unverified' ? null : `${i}-${r.id}-${kind === 'mixed' ? index : 'response'}`,
      }]))
    }
  }
  await store.flush()
  const app = Fastify()
  const scenario = (req: any) => String(req.headers['x-test-scenario'] ?? /(?:^|;\s*)probeTestScenario=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'normal')
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
    if (!['GET', 'HEAD'].includes(req.method)) return reply.code(405).send({ error: '隔离测试版只读：设备通信、配置修改和模型调用均禁用' })
    if (req.url.startsWith('/api/data/object/') || req.url.startsWith('/api/export/')) {
      if (scenario(req) === 'invalid') {
        const q = req.query as Record<string, string>
        q.start = new Date(now - 410000).toISOString(); q.end = new Date(now - 329000).toISOString()
      }
      if (scenario(req) === 'error') return reply.code(503).send({ error: '合成查询失败：切换恢复后重新查询' })
      if (scenario(req) === 'empty' && req.url.startsWith('/api/data/object/series')) return reply.send({ series: [], sourceSamples: 0, displayedSamples: 0, downsampled: false, complete: true })
      if (scenario(req) === 'empty' && req.url.startsWith('/api/data/object/page')) return reply.send({ points: [], total: 0 })
    }
  })
  app.addHook('onSend', async (_req, reply, payload) => {
    if (String(reply.getHeader('content-type')).includes('text/html') && typeof payload === 'string') return payload.replace('<body>', '<body>' + controls)
    return payload
  })
  // Serve index ourselves so the test banner cannot be skipped by a streamed static response.
  const { readFile } = await import('node:fs/promises')
  app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(join(staticDir, 'index.html'), 'utf8')))
  await app.register(fastifyStatic, { root: staticDir, prefix: '/', index: false })
  await app.register(websocket)
  app.get('/ws', { websocket: true }, socket => {
    socket.send(JSON.stringify({ type: 'latest', data: {} }))
    socket.on('message', () => socket.send(JSON.stringify({ type: 'pong' })))
  })
  app.get('/api/test-info', () => ({ edition: 'offline-readonly', dataDir, start, end, deviceId: device.id, registerIds: [reg.id, wide.id], cases, disabled: ['hardware', 'serial', 'poller', 'slave', 'AI', 'configuration writes'], realDataOpened: false }))
  app.get('/api/monitor_objects', () => cfg.listObjects().map(d => ({ ...d, connected: false })))
  app.get('/api/monitor_objects/:id/groups', () => cfg.listGroups(device.id))
  app.get('/api/groups/:id/registers', req => cfg.listRegisters(Number((req.params as any).id)))
  app.get('/api/monitor_objects/:id/latest', () => ({}))
  app.get('/api/monitor_objects/:id/slaves', () => [])
  app.get('/api/rules', () => [])
  app.get('/api/logs', () => [])
  app.get('/api/ai/issues', () => ({ issues: [] }))
  app.get('/api/ai/settings', () => ({ provider: 'custom', model: '', baseUrl: '', hasKey: false }))
  app.get('/api/ai/providers', () => ({ providers: [], configured: [] }))
  app.get('/api/ai/sessions', () => [])
  app.get('/api/data/object/page', req => {
    const q = req.query as any
    return store.queryObjectPage(device.id, q.start, q.end, Number(q.page) || 0, Number(q.page_size) || 200)
  })
  app.get('/api/data/stats', () => store.statsByObject(device.id))
  app.get('/api/monitor_objects/:id/stats', () => store.statsByObject(device.id))
  registerCurve(app, cfg, store)
  // Only metadata enumeration is enabled; no serial port is ever opened by this route.
  registerSerialPorts(app)
  for (const format of ['csv', 'xlsx'] as const) app.get('/api/export/' + format, async (req, reply) => {
    const q = req.query as any, ids = q.register_ids?.split(',').map(Number)
    reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="offline-history.${format}"`)
    return format === 'csv' ? sink.exportCsv(device.id, q.start, q.end, ids, Number(q.tz) || 0) : sink.exportXlsx(device.id, q.start, q.end, ids, Number(q.tz) || 0)
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '此能力未包含在只读隔离测试版中' }))
  app.addHook('onClose', async () => {
    await store.flush(); await (store as any).mutations
    const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync(); (cfg as any).db.close()
  })
  return { app, dataDir, start, end, deviceId: device.id, registerIds: [reg.id, wide.id] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4181)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('测试端口必须为 1024–65535')
  const { app, dataDir } = await createOfflineTestApp()
  try {
    const address = await app.listen({ host: '127.0.0.1', port })
    console.log(`隔离只读测试版：${address}\n专用合成数据：${dataDir}\n选择设备 → 历史；停止：Ctrl+C。未加载任何硬件或模型服务。`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0) })
  } catch (error) { await app.close(); throw error }
}
