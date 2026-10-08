import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { boot } from './_bootstrap.ts'
const freePort=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port}
const {ctx}=await boot({slave:await freePort(),api:{},rule:true})
const app:any=ctx.get('api',false),manager:any=ctx.get('deviceSlaves',false),store:any=ctx.get('store',false)
assert(manager,'device slave service registered through Cordis')
try {
  const port=await freePort()
  const created=await app.inject({method:'POST',url:'/api/monitor_objects',payload:{name:'API slave',ip:'127.0.0.1',port,mode:'slave',slaveId:3}})
  assert.equal(created.statusCode,200,created.body);const device=created.json()
  const groups=await app.inject({method:'POST',url:`/api/monitor_objects/${device.id}/groups`,payload:{name:'Points',functionCode:3,startAddress:0,quantity:1}})
  assert.equal(groups.statusCode,200,groups.body)
  const group=groups.json(), cfg:any=ctx.get('config',false), reg=cfg.listRegisters(group.id)[0]
  assert(reg)
  const write=await app.inject({method:'POST',url:`/api/registers/${reg.id}/write`,payload:{value:1234}})
  assert.equal(write.statusCode,200,write.body)
  assert.equal(store.getLatest()[`${device.id}:holding-register:0`].rawValue,1234)
  const objects=(await app.inject({method:'GET',url:'/api/monitor_objects'})).json()
  assert(objects.find((o:any)=>o.id===device.id).connected)
  assert((await app.inject({method:'GET',url:`/api/monitor_objects/${device.id}/slave`})).json().connected)
  await app.inject({method:'POST',url:`/api/monitor_objects/${device.id}/toggle`});assert(!manager.connected(device.id))
  await app.inject({method:'POST',url:`/api/monitor_objects/${device.id}/toggle`});assert(manager.connected(device.id))
  const changed=await app.inject({method:'PUT',url:`/api/monitor_objects/${device.id}`,payload:{mode:'master'}})
  assert.equal(changed.statusCode,200,changed.body);assert(!manager.connected(device.id))
  assert.equal((await app.inject({method:'PUT',url:`/api/monitor_objects/${device.id}`,payload:{mode:'invalid'}})).statusCode,400)
  console.log('DEVICE SLAVE API OK: plugin wiring, device CRUD role, listener lifecycle, point writes and shared latest data')
} finally {await manager.stop();await (ctx.get('slave',false) as any).stop();await app.close()}
process.exit(0)
