import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SerialDriver } from '../packages/modbus/src/index.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { apply as applyPoller } from '../packages/poller/src/index.ts'

// Synthetic paths, explicit constructor injection; never instantiate native SerialPort or start a service.
type Mode = 'ok' | 'hang' | 'event-error' | 'callback-error'
class Port extends EventEmitter {
  static mode: Mode = 'ok'; static instances: Port[] = []; static holdClose = false
  isOpen = true; closes = 0; finishClose: (() => void) | null = null; callback: (error?: Error | null) => void
  constructor(_options: unknown, callback: (error?: Error | null) => void) {
    super(); this.callback = callback; Port.instances.push(this)
    queueMicrotask(() => { if (Port.mode === 'ok') callback(null); if (Port.mode === 'event-error') this.emit('error', Error('synthetic open error')); if (Port.mode === 'callback-error') callback(Error('synthetic callback error')) })
  }
  close(callback?: () => void) { this.closes++; const finish = () => { this.isOpen = false; this.emit('close'); callback?.() }; if (Port.holdClose) this.finishClose = finish; else finish() }
  write() { assert.fail('no frame writes permitted in driver-open tests') }
}
const opts = { serialPath: 'MOCK_ONLY', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none' }
const config = { defaultTimeoutMs: 100, defaultUnitId: 1, connectTimeoutMs: 20 }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function bounded<T>(work: Promise<T>) { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic lifecycle deadline')),2000)})]) } finally { clearTimeout(timer) } }
function driver(mode: Mode) { Port.mode = mode; Port.instances = []; Port.holdClose = false; return new SerialDriver(config,Port,()=>{}) }
let passed = 0
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log('RTU LIFECYCLE OK: '+name) }
async function harness(factory: () => any, run: (h: any) => Promise<void>, threshold = 0) {
  let engine: any; const listeners = new Map<string, ((value: any) => void)[]>(), events: any[] = [], cleanup: (()=>Promise<void>)[] = []
  const emit = (name: string, value: any) => { events.push({name,value}); for (const handler of listeners.get(name)??[]) handler(value) }
  const cfg = new ConfigStore({dbPath:':memory:'},(scope,id)=>emit('config/changed',{scope,id}))
  const a=cfg.createObject('synthetic A','mock.invalid',502,'master',{transport:'rtu',serialPath:'MOCK_SHARED',pollIntervalMs:100}), ga=cfg.createGroup(a.id,'synthetic A',3,0,1,'read',1)
  const b=cfg.createObject('synthetic B','mock.invalid',502,'master',{transport:'rtu',serialPath:'MOCK_SHARED',pollIntervalMs:100}), gb=cfg.createGroup(b.id,'synthetic B',3,0,1,'read',2)
  const ctx:any={config:cfg,store:{write(){},async flush(){}},modbus:{createDriver:factory},on(name:string,fn:any){listeners.set(name,[...listeners.get(name)??[],fn])},emit,provide(_name:string,value:any){engine=value},effect(setup:any){cleanup.push(setup())},logger:()=>({info(){},warn(){}})}
  applyPoller(ctx,{pollIntervalMs:100,connectRetryMs:0,watchdogTimeoutMs:30000,autoResetFailThreshold:threshold,autoResetCooldownMs:0})
  engine.refreshSchedule()
  try { await run({cfg,engine,a,b,ga,gb,events,poll:(id:number)=>engine.pollNextGroup(cfg.getObject(id))}) }
  finally { for (const close of cleanup) await close(); await cfg.close() }
}

await check('hung open rejects, closes best-effort, and late successful callback cannot reconnect',async()=>{
  const d=driver('hang'); await assert.rejects(bounded(d.connect(opts)),/open timed out/); const port=Port.instances[0]
  assert(!d.isConnected()); assert(port.closes>=1); port.isOpen=true; port.callback(null); assert(!d.isConnected()); assert(!port.isOpen); await d.disconnect()
})
await check('open-stage error event closes a half-open port even without its constructor callback',async()=>{
  const d=driver('event-error'); await assert.rejects(bounded(d.connect(opts)),/synthetic open error/)
  assert(!d.isConnected()); assert(Port.instances[0].closes>=1,'open error must attempt half-open cleanup'); assert(!Port.instances[0].isOpen); await d.disconnect()
})
await check('constructor callback error also cleans up a half-open port',async()=>{
  const d=driver('callback-error'); await assert.rejects(bounded(d.connect(opts)),/synthetic callback error/); assert(Port.instances[0].closes>=1); assert(!d.isConnected()); await d.disconnect()
})
await check('normal disconnect awaits the close callback; runtime close permits a new open',async()=>{
  const d=driver('ok'); await d.connect(opts); const old=Port.instances[0]; Port.holdClose=true
  let done=false; const closing=d.disconnect().then(()=>{done=true}); await tick(); assert(!done); assert(!d.isConnected()); assert.equal(old.closes,1)
  old.finishClose!(); await closing; Port.holdClose=false; await d.connect(opts); assert(d.isConnected()); assert.equal(Port.instances.length,2)
  Port.instances[1].emit('close'); assert(!d.isConnected()); await d.disconnect()
})
await check('hung native-open model surfaces a poller group error and watchdog fallback',async()=>{
  driver('hang'); await harness(()=>new SerialDriver(config,Port,()=>{}),async({engine,a,events,poll})=>{
    await bounded(poll(a.id)); assert(events.some((e:any)=>e.name==='poller/group-error'&&/open timed out/.test(e.value.error))); assert(!events.some((e:any)=>e.name==='poller/result'))
    engine.lastOutcomeAt.set(a.id,Date.now()-60000); engine.runWatchdog(); assert(events.some((e:any)=>e.name==='poller/group-error'&&/watchdog/.test(e.value.error)))
  })
})
await check('shared port remains for another active device; last disable/delete releases exactly once',async()=>{
  for(const action of ['disable','delete']){let connects=0,closes=0,connected=false
    const d={async connect(){connects++;connected=true},async disconnect(){closes++;connected=false},isConnected:()=>connected,async readHoldingRegisters(){return[1]}}
    await harness(()=>d,async({cfg,a,b,poll})=>{await poll(a.id);await poll(b.id);assert.equal(connects,1);cfg.updateObject(a.id,{isActive:0});assert.equal(closes,0);if(action==='delete')cfg.deleteObject(b.id);else cfg.updateObject(b.id,{isActive:0});await tick();assert.equal(closes,1)})
  }
})
await check('repeated simulated read failures rebuild the RTU driver and clear visible error after success',async()=>{
  let generation=0,closes=0
  await harness(()=>{const current=++generation;let connected=false;return{async connect(){connected=true},async disconnect(){closes++;connected=false},isConnected:()=>connected,async readHoldingRegisters(){if(current===1)throw Error('synthetic read Timeout');return[7]}}},async({a,events,poll})=>{
    await poll(a.id);await poll(a.id);assert.equal(closes,1);await poll(a.id);assert.equal(generation,2);assert(events.some((e:any)=>e.name==='poller/group-error'));assert(events.some((e:any)=>e.name==='poller/group-ok'));assert(events.some((e:any)=>e.name==='poller/result'&&e.value.points[0].rawValue===7))
  },2)
})
console.log(`RTU LIFECYCLE TEST OK: ${passed} injected-port/poller groups; no real ports, native enumeration, services or data`)
