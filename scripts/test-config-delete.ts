import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import ts from 'typescript'
import Fastify from 'fastify'
import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConfigStore } from '../packages/config/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

type Kind = 'device' | 'group' | 'register'
const kinds: Kind[] = ['device','group','register'], red = process.argv[2] === 'red'
const caught = (action: () => unknown) => { try { action(); return { threw: false, error: undefined } } catch (error) { return { threw: true, error } } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve)), normalized = (value: unknown) => JSON.parse(JSON.stringify(value))
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target))
const results: string[] = [], failures: string[] = [], denied: string[] = [], unhandled: unknown[] = []
const run = async (name: string, work: () => void | Promise<void>) => { try { await work(); results.push(name); console.log('CONFIG DELETE OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('CONFIG DELETE REPRO: ' + failures.at(-1)) } }
class FakeHttp extends EventEmitter {
  listening = false; closes = 0
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); return this }
  close(done: () => void) { this.listening = false; this.closes++; queueMicrotask(done); return this }
}
function fixture() {
  let armed = false, failNotify = false, graph = () => ''
  const events: { scope: string; id?: number; transaction: boolean; graph: string }[] = [], notifyFailure = Error('synthetic observer failure')
  let db!: DatabaseSync
  const cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => { if (armed) { events.push({ scope, id, transaction: db.isTransaction, graph: graph() }); if (failNotify) throw notifyFailure } })
  const d = cfg.createObject('target', 'mock.invalid', 502), keep = cfg.createObject('keep', 'keep.mock.invalid', 502)
  const g = cfg.createGroup(d.id, 'target group', 3, 0, 2), sibling = cfg.createGroup(d.id, 'sibling', 3, 10, 1), other = cfg.createGroup(keep.id, 'other', 3, 0, 1)
  const points = [cfg.createRegister(g.id,d.id,'first',3,0,'uint16'),cfg.createRegister(g.id,d.id,'second',3,1,'uint16'),cfg.createRegister(sibling.id,d.id,'sibling',3,10,'uint16'),cfg.createRegister(other.id,keep.id,'other',3,0,'uint16')]
  const rules = points.map(point => cfg.createRule(point.id,'>',1,'sentinel rule'))
  cfg.log('INFO','synthetic','sentinel log')
  db = (cfg as unknown as { db: DatabaseSync }).db
  db.exec("INSERT INTO firmwares (name, version, size, file_path) VALUES ('synthetic sentinel','1',1,'not-a-real-file'); CREATE TABLE synthetic_history (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO synthetic_history VALUES (1,'preserve')")
  graph = () => JSON.stringify({ objects:cfg.listObjects(),groups:[...cfg.listGroups(d.id),...cfg.listGroups(keep.id)],points:[...cfg.listRegistersByObject(d.id),...cfg.listRegistersByObject(keep.id)],rules:cfg.listRules(),logs:cfg.listLogs(),firmwares:db.prepare('SELECT * FROM firmwares ORDER BY id').all(),history:db.prepare('SELECT * FROM synthetic_history').all() })
  const keepBefore = JSON.stringify({ device:cfg.getObject(keep.id),group:cfg.getGroup(other.id),point:cfg.getRegister(points[3].id),rule:cfg.listRules().find(rule => rule.id === rules[3].id) })
  const sentinels = JSON.stringify({ logs:cfg.listLogs(),firmwares:db.prepare('SELECT * FROM firmwares').all(),history:db.prepare('SELECT * FROM synthetic_history').all() })
  const remove = (kind: Kind) => kind === 'device' ? cfg.deleteObject(d.id) : kind === 'group' ? cfg.deleteGroup(g.id) : cfg.deleteRegister(points[0].id)
  const id = (kind: Kind) => kind === 'device' ? d.id : kind === 'group' ? g.id : points[0].id
  const scope = (kind: Kind) => kind === 'device' ? 'object' : kind
  const steps = (kind: Kind) => kind === 'device' ? [['alarm_rules',rules[0].id],['registers',points[0].id],['register_groups',g.id],['monitor_objects',d.id]] as const : kind === 'group' ? [['alarm_rules',rules[0].id],['registers',points[0].id],['register_groups',g.id]] as const : [['alarm_rules',rules[0].id],['registers',points[0].id]] as const
  const blockStep = (kind: Kind, step: number) => { const [table,row] = steps(kind)[step]; db.exec(`CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON ${table} WHEN OLD.id = ${row} BEGIN SELECT RAISE(ABORT, 'synthetic DELETE blocked'); END`) }
  const assertRemoved = (kind: Kind, allowLog = false) => {
    assert.equal(cfg.getObject(d.id) === undefined,kind === 'device'); assert.equal(cfg.getGroup(g.id) === undefined,kind !== 'register')
    assert.equal(cfg.getRegister(points[0].id),undefined); assert.equal(cfg.getRegister(points[1].id) === undefined,kind !== 'register'); assert.equal(cfg.getRegister(points[2].id) === undefined,kind === 'device')
    assert.equal(cfg.listRules().length,kind === 'device' ? 1 : kind === 'group' ? 2 : 3)
    assert.equal(JSON.stringify({ device:cfg.getObject(keep.id),group:cfg.getGroup(other.id),point:cfg.getRegister(points[3].id),rule:cfg.listRules().find(rule => rule.id === rules[3].id) }),keepBefore,'unrelated device graph must remain unchanged')
    const logs = allowLog ? cfg.listLogs().filter(log => log.source === 'synthetic') : cfg.listLogs()
    assert.equal(JSON.stringify({ logs,firmwares:db.prepare('SELECT * FROM firmwares').all(),history:db.prepare('SELECT * FROM synthetic_history').all() }),sentinels,'logs/firmware/history are outside deletion scope')
  }
  const originalExec = db.exec.bind(db)
  return { cfg,db,d,keep,g,sibling,points,rules,events,notifyFailure,graph,remove,id,scope,steps,blockStep,assertRemoved,arm:()=>{armed=true},notifyFail:()=>{failNotify=true},close:async()=>{db.exec=originalExec;if(db.isTransaction)originalExec('ROLLBACK');await cfg.close()} }
}
const onUnhandled = (error: unknown) => { unhandled.push(error) }, listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch, block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: '+name) }
net.Server.prototype.listen=block('listen') as typeof listen;net.Socket.prototype.connect=block('connect') as typeof connect;globalThis.fetch=block('fetch') as typeof fetch;process.on('unhandledRejection',onUnhandled)
try {
  for(const kind of kinds) for(let step=0;step<(kind==='device'?4:kind==='group'?3:2);step++) await run(kind+'/SQL-step-'+(step+1),async()=>{
    const f=fixture();try{f.blockStep(kind,step);const before=f.graph();f.arm();const result=caught(()=>f.remove(kind));assert.equal(result.threw,true);assert.equal(f.graph(),before,'a failed delete step must roll back preceding deletes');assert.equal(f.db.isTransaction,false);assert.equal(f.events.length,0)}finally{await f.close()}
  })
  for(const kind of kinds) await run(kind+'/outer-failure',async()=>{
    const f=fixture();try{f.db.exec('BEGIN');f.db.prepare('UPDATE monitor_objects SET name=? WHERE id=?').run('outer-kept',f.keep.id);f.blockStep(kind,1);const before=f.graph();f.arm();assert.equal(caught(()=>f.remove(kind)).threw,true);assert.equal(f.db.isTransaction,true);assert.equal(f.graph(),before,'only the failed delete unit rolls back, not earlier caller work');assert.equal(f.events.length,0);f.db.exec('COMMIT');assert.equal(f.cfg.getObject(f.keep.id)?.name,'outer-kept')}finally{await f.close()}
  })
  if(!red){
    for(const kind of kinds) for(const mode of ['success','missing','outer-success','notify-failure']) await run(kind+'/'+mode,async()=>{
      const f=fixture();try{const before=f.graph();if(mode==='outer-success')f.db.exec('BEGIN');if(mode==='notify-failure')f.notifyFail();f.arm()
        if(mode==='missing'){const absent=99999;const result=caught(()=>kind==='device'?f.cfg.deleteObject(absent):kind==='group'?f.cfg.deleteGroup(absent):f.cfg.deleteRegister(absent));assert.equal(result.threw,false);assert.equal(f.graph(),before);assert.deepEqual(f.events.map(({scope,id})=>({scope,id})),[{scope:f.scope(kind),id:absent}])}
        else{const result=caught(()=>f.remove(kind));f.assertRemoved(kind);assert.equal(f.events.length,1);assert.equal(f.events[0].scope,f.scope(kind));assert.equal(f.events[0].id,f.id(kind));assert.equal(f.events[0].graph,f.graph());assert.equal(f.events[0].transaction,mode==='outer-success');if(mode==='notify-failure'){assert.equal(result.threw,true);assert(result.error instanceof Error&&result.error.message.includes('已提交'));assert.equal(result.error.cause,f.notifyFailure)}else assert.equal(result.threw,false)
          if(mode==='outer-success'){assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');assert.equal(f.graph(),before)}
        }assert.equal(f.db.isTransaction,false)
      }finally{await f.close()}
    })
    for(const mode of ['bulk-success','bulk-failure'])await run(mode,async()=>{
      const f=fixture();try{const before=f.graph();if(mode==='bulk-failure')f.db.exec(`CREATE TRIGGER synthetic_bulk_failure BEFORE DELETE ON registers WHEN OLD.id = ${f.points[1].id} BEGIN SELECT RAISE(ABORT, 'synthetic bulk DELETE blocked'); END`);f.arm();const result=caught(()=>f.cfg.updateGroup(f.g.id,{quantity:1}));if(mode==='bulk-success'){assert.equal(result.threw,false);assert.equal(f.cfg.listRegisters(f.g.id).length,1);assert.deepEqual(f.events.map(event=>event.scope),['group'])}else{assert.equal(result.threw,true);assert.equal(f.graph(),before);assert.equal(f.events.length,0)}assert.equal(f.db.isTransaction,false)}finally{await f.close()}
    })
    await run('recording-lease-conservative',async()=>{
      const f=fixture();try{const {lease}=f.cfg.acquireRecordingInterval(f.d.id,250);assert.equal(f.cfg.recordingIntervalLeaseValid(lease),true);f.blockStep('device',3);const before=f.graph();f.arm();assert.equal(caught(()=>f.remove('device')).threw,true);assert.equal(f.graph(),before);assert.equal(f.cfg.recordingIntervalLeaseValid(lease),false);assert.equal(f.cfg.restoreRecordingInterval(lease).state,'preserved');assert.equal(f.cfg.getObject(f.d.id)?.pollIntervalMs,250);assert.equal(f.events.length,0)}finally{await f.close()}
    })
    for(const mode of ['savepoint-start','release-before','release-after','rollback-root','rollback-outer','rollback-all-fail','rollback-release-fail'])await run(mode,async()=>{
      const f=fixture(),exec=f.db.exec.bind(f.db),injected=Error('synthetic '+mode),fallback=Error('synthetic fallback rollback'),outer=mode==='rollback-outer';let released=false,releaseFaulted=false
      try{if(outer){exec('BEGIN');f.db.prepare('UPDATE monitor_objects SET name=? WHERE id=?').run('outer-kept',f.keep.id)}const before=f.graph();if(mode.startsWith('rollback'))f.blockStep('device',1)
        f.db.exec=sql=>{if(mode==='savepoint-start'&&sql.startsWith('SAVEPOINT config_delete_'))throw injected
          if((mode==='release-before'||mode==='release-after')&&sql.startsWith('RELEASE SAVEPOINT ')&&!releaseFaulted){releaseFaulted=true;if(mode==='release-after'){exec(sql);released=true}throw injected}
          if((mode==='rollback-root'||mode==='rollback-outer'||mode==='rollback-all-fail')&&sql.startsWith('ROLLBACK TO SAVEPOINT '))throw injected
          if(mode==='rollback-all-fail'&&sql==='ROLLBACK')throw fallback
          if(mode==='rollback-release-fail'&&sql.startsWith('RELEASE SAVEPOINT '))throw injected
          return exec(sql)}
        f.arm();const result=caught(()=>f.remove('device'));assert.equal(result.threw,true);assert.equal(f.events.length,0)
        if(mode==='savepoint-start'||mode==='release-before'){assert.equal(result.error,injected);assert.equal(f.graph(),before);assert.equal(f.db.isTransaction,false)}
        else if(mode==='release-after'){assert.equal(released,true);f.assertRemoved('device');assert(result.error instanceof AggregateError&&result.error.message.includes('待核实'));assert(contains(result.error,injected));assert.equal(f.db.isTransaction,false)}
        else if(mode==='rollback-root'||mode==='rollback-release-fail'){assert(result.error instanceof AggregateError);assert(contains(result.error,injected));assert.equal(f.graph(),before);assert.equal(f.db.isTransaction,false)}
        else{assert(result.error instanceof AggregateError);assert(contains(result.error,injected));assert.equal(f.db.isTransaction,true);assert.notEqual(f.graph(),before);if(outer)assert.equal(f.cfg.getObject(f.keep.id)?.name,'outer-kept');else assert(contains(result.error,fallback));exec('ROLLBACK')}
      }finally{await f.close()}
    })
    const apiSource=ts.createSourceFile('api.ts',readFileSync(new URL('../packages/api/src/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
    const routes=new Map<string,string>();const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='delete'&&ts.isStringLiteral(node.arguments[0]))routes.set(node.arguments[0].text,node.getText(apiSource));ts.forEachChild(node,visit)};visit(apiSource)
    for(const surface of ['MCP','REST'])for(const kind of kinds)for(const fail of [false,true])await run(surface+'/'+kind+'/'+(fail?'failure':'success'),async()=>{
      const f=fixture(),ctx=new Context(),httpServer=new FakeHttp(),create=http.createServer;let client:Client|undefined,sdk:McpServer|undefined,syncs=0;const app=Fastify()
      try{if(fail)f.blockStep(kind,1);const before=f.graph();f.arm()
        if(surface==='MCP'){
          await ctx.plugin({name:'inert-config-delete-services',apply(context:Context){context.provide('config',f.cfg as any);context.provide('deviceSlaves',{async sync(){syncs++}} as any);for(const service of ['store','poller','ota','sink'])context.provide(service as any,{} as any)}})
          http.createServer=(()=>httpServer) as unknown as typeof create;try{await ctx.plugin(mcpPlugin,{host:'127.0.0.1',port:0})}finally{http.createServer=create}
          sdk=(ctx.get('mcp',false) as {createServer():McpServer}).createServer();client=new Client({name:'synthetic delete',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await Promise.all([sdk.connect(b),client.connect(a)])
          const args=kind==='device'?{device_id:f.d.id}:kind==='group'?{group_id:f.g.id}:{register_id:f.points[0].id};const result=await client.callTool({name:'delete_'+(kind==='register'?'register':kind),arguments:args})
          if(fail)assert.equal(result.isError,true);else{assert.equal(result.isError,undefined);assert(Array.isArray(result.content));assert.deepEqual(JSON.parse(String(result.content[0]?.text)),kind==='device'?{ok:true,device_id:f.d.id,history_preserved:true}:kind==='group'?{ok:true,group_id:f.g.id}:{ok:true,register_id:f.points[0].id})}
        }else{const path=kind==='device'?'/api/monitor_objects/:id':kind==='group'?'/api/groups/:id':'/api/registers/:id',registration=routes.get(path);assert(registration);new Function('fastify','cfg','ctx',ts.transpileModule(registration,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(app,f.cfg,{get:()=>({async sync(){syncs++}})});const response=await app.inject({method:'DELETE',url:path.replace(':id',String(f.id(kind)))});assert.equal(response.statusCode,fail?500:200);if(!fail)assert.deepEqual(response.json(),{ok:true})}
        if(fail){assert.equal(f.graph(),before);assert.equal(f.events.length,0);assert.equal(syncs,0)}else{f.assertRemoved(kind,surface==='MCP');assert.equal(f.events.length,1);assert.equal(syncs,kind==='device'?1:0)}
      }finally{http.createServer=create;await client?.close();await sdk?.close();await ctx.fiber.dispose();await app.close();await f.close();if(surface==='MCP')assert.equal(httpServer.closes,1)}
    })
  }
  await tick();assert.deepEqual(unhandled,[]);assert.deepEqual(denied,[]);assert.deepEqual(failures,[])
}finally{net.Server.prototype.listen=listen;net.Socket.prototype.connect=connect;globalThis.fetch=fetch;process.off('unhandledRejection',onUnhandled)}
console.log('CONFIG DELETE TEST OK: '+results.length+' native-memory SQL-step/savepoint/scope/lease and real MCP/REST cases; unknown rollback/release failures remain errors, no real databases, sockets, devices or models')
