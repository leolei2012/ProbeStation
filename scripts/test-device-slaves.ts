import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { ModbusTCPClient } from 'jsmodbus'
import { SerialPortMock } from 'serialport'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DeviceSlaves } from '../packages/slave/src/devices.ts'
import { apply as applyPoller } from '../packages/poller/src/index.ts'
const port = async () => { const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p }
const cfg = new ConfigStore({dbPath:':memory:'}), events: any[] = [], samples: any[] = []
const manager = new DeviceSlaves(cfg,{write:(points:any[])=>samples.push(...points)},(event,payload)=>events.push({event,payload}),SerialPortMock)
const a=cfg.createObject('Slave A','127.0.0.1',await port(),'slave',{slaveId:7,pollIntervalMs:100})
const b=cfg.createObject('Slave B','127.0.0.1',await port(),'slave',{slaveId:7,pollIntervalMs:100})
const ga=cfg.createGroup(a.id,'Holding',3,0,4), gb=cfg.createGroup(b.id,'Holding',3,0,4)
const ra=cfg.createRegister(ga.id,a.id,'Float',3,0,'float32');cfg.createRegister(gb.id,b.id,'Word',3,0,'uint16')
const sockets: net.Socket[]=[]
const client=async(d:any)=>{const socket=new net.Socket();sockets.push(socket);const c=new ModbusTCPClient(socket,7,1000);socket.connect(d.port,'127.0.0.1');await once(socket,'connect');return c}
try {
  await manager.sync();assert(manager.connected(a.id)&&manager.connected(b.id))
  let poller: any
  applyPoller({ provide: (_name: string, service: any) => { poller = service }, config: cfg, deviceSlaves: manager, on: () => {}, modbus: { createDriver: () => { throw new Error('slave must not open a master driver') } } } as any, { pollIntervalMs: 1000, connectRetryMs: 5000, watchdogTimeoutMs: 30000, autoResetFailThreshold: 3, autoResetCooldownMs: 5000 })
  assert(poller.isDeviceConnected(a.id)); assert(poller.listConnectionStates().some(s=>s.objectId===b.id&&s.connected))
  await poller.write(b.id, 0, [12], 'multiple', 7, 'holding-register')
  const ca=await client(a), cb=await client(b)
  await ca.writeMultipleRegisters(0,[0x4148,0]);assert.deepEqual((await ca.readHoldingRegisters(0,2)).response.body.valuesAsArray,[0x4148,0]);assert.deepEqual((await cb.readHoldingRegisters(0,1)).response.body.valuesAsArray,[12])
  await manager.write(b.id,'holding-register',0,[42]);assert.deepEqual((await cb.readHoldingRegisters(0,1)).response.body.valuesAsArray,[42])
  await new Promise(r=>setTimeout(r,110));await manager.sync()
  assert(samples.some(p=>p.objectId===a.id&&p.address===1), 'complete multiword samples are published')
  assert(samples.some(p=>p.objectId===a.id&&p.rawValue===0x4148),'external master writes feed realtime/history/alarm pipeline')
  cfg.toggleObject(a.id);await manager.sync();assert(!manager.connected(a.id))
  cfg.toggleObject(a.id);await manager.sync();assert(manager.connected(a.id))
  const ca2=await client(a);assert.deepEqual((await ca2.readHoldingRegisters(0,2)).response.body.valuesAsArray,[0x4148,0], 'restart retains device memory')
  cfg.updateObject(a.id,{mode:'master'});await manager.sync();assert(!manager.connected(a.id)&&manager.connected(b.id))
  const probe=net.createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(a.port,'127.0.0.1',resolve)});await new Promise<void>(r=>probe.close(()=>r()))
  SerialPortMock.binding.reset();SerialPortMock.binding.createPort('DEVICE_RTU',{record:true})
  const c=cfg.createObject('RTU slave','',502,'slave',{transport:'rtu',serialPath:'DEVICE_RTU',dataBits:8,parity:'none',slaveId:9})
  const gc=cfg.createGroup(c.id,'Input',4,0,1);cfg.createRegister(gc.id,c.id,'Input value',4,0,'uint16')
  await manager.sync();assert(manager.connected(c.id));await manager.write(c.id,'input-register',0,[250])
  assert(samples.some(p=>p.objectId===c.id&&p.area==='input-register'&&p.rawValue===250))
  assert.throws(()=>cfg.createObject('bad','127.0.0.1',502,'unknown'),/角色/)
  assert.throws(()=>cfg.updateObject(c.id,{dataBits:7}),/数据位/)
  cfg.deleteObject(b.id);await manager.sync();assert(!manager.connected(b.id)&&manager.connected(c.id))
  assert(events.some(e=>e.event==='device/status'&&e.payload.objectId===a.id&&!e.payload.connected))
  console.log('DEVICE SLAVES OK: isolated devices, TCP external writes, local memory edits, complete values, RTU, pause/restart, role switching, deletion and validation')
}finally{for(const socket of sockets)socket.destroy();await manager.stop();SerialPortMock.binding.reset()}
