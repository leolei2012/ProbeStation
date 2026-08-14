import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 18080 })

// write a sample so latest is non-empty
const store = ctx.get('store', false)
store.write([{ objectId: 1, registerId: 1, timestamp: new Date().toISOString(), rawValue: 555, quality: 'good' }])
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

// emit poller/result -> expect ws broadcast
ctx.emit('poller/result', { objectId: 1, points: [{ objectId: 1, registerId: 1, timestamp: new Date().toISOString(), rawValue: 777, quality: 'good' }] })
await new Promise((r) => setTimeout(r, 200))
console.log('after emit, received[1] =', received[1])

ws.close()
await app.close()
console.log('WS TEST OK')
