import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: { port: 18080 } })

// write a sample so latest is non-empty
const store = ctx.get('store', false)
store.write([{ objectId: 1, area: 'holding-register', address: 1, timestamp: new Date().toISOString(), rawValue: 555, quality: 'good' }])
await store.flush()

const app = ctx.get('api', false)
await app.listen({ host: '127.0.0.1', port: 18080 })
console.log('api listening on 127.0.0.1:18080')

// connect ws client (Node 24 global WebSocket)
const ws = new WebSocket('ws://127.0.0.1:18080/ws')
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = (e) => reject(e)
})
console.log('ws connected')

const received: string[] = []
ws.onmessage = (e) => received.push(String(e.data))

// wait for initial 'latest'
await new Promise((r) => setTimeout(r, 200))
console.log('after connect, received[0] =', received[0])

// application-level heartbeat
ws.send(JSON.stringify({ type: 'ping', timestamp: 12345 }))
await new Promise((r) => setTimeout(r, 100))
const pong = received.map((x) => { try { return JSON.parse(x) } catch { return null } }).find((x) => x?.type === 'pong')
if (pong?.timestamp !== 12345) throw new Error('heartbeat pong missing')
console.log('heartbeat pong OK')

// emit poller/result -> expect ws broadcast
ctx.emit('poller/result', { objectId: 1, points: [{ objectId: 1, address: 1, timestamp: new Date().toISOString(), rawValue: 777, quality: 'good' }] })
await new Promise((r) => setTimeout(r, 200))
const result = received.map((x) => { try { return JSON.parse(x) } catch { return null } }).find((x) => x?.type === 'poller/result')
if (result?.points?.[0]?.rawValue !== 777) throw new Error('poller/result broadcast missing')
console.log('poller/result broadcast OK')

ws.close()
await app.close()
console.log('WS TEST OK')
process.exit(0)
