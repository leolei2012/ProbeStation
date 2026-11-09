import assert from 'node:assert/strict'
import path from 'node:path'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import React from 'react'
import ts from 'typescript'
import Fastify from 'fastify'
import {renderToStaticMarkup} from 'react-dom/server'
const load=file=>import(pathToFileURL(path.join(process.cwd(),file)).href)
const {hookDriver}=await load('scripts/fixtures/component-hook-driver.ts')
const {RawFramesRead,clampFrameLimit}=await load('apps/web/src/raw-frames-read.ts')
const {RawFramesStatus}=await load('apps/web/src/RawFramesStatus.tsx')
const {ModbusDiagnostics}=await load('packages/modbus/src/diagnostics.ts')
const tick=()=>new Promise(done=>setImmediate(done)),deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const device={id:1,name:'Mock A',transport:'tcp',ip:'a.mock.invalid',port:502}
const frames=(target,tag,marked=true)=>{
 const diag=new ModbusDiagnostics(target.transport,2000,target.transport==='tcp'?{deviceId:target.id,channelKey:'tcp:'+target.id}:{channelKey:'rtu:'+target.serialPath})
 const header=target.transport==='tcp'?[0,1,0,0,0,3,1]:[1]
 diag.recordFrame('rx',Uint8Array.from([...header,3,tag]));if(marked)diag.recordFrame('rx',Uint8Array.from([...header,0x83,tag]));return diag.getFrames()
}
const Summary=()=>null,Cleanup=()=>null
function harness(english,initialDevice=device){
 let props={device:initialDevice,t:key=>key==='cancel'?(english?'Cancel':'取消'):key},nextInterval=0
 const requests=[],intervals=new Map(),readers=[],commits=[]
 class Read extends RawFramesRead{constructor(...args){super(...args);readers.push(this)}}
 const driver=hookDriver('App.tsx','RawDataView',hooks=>{
  const memo=(factory,deps)=>{const cell=hooks.useRef();if(!cell.current||deps.some((item,i)=>!Object.is(item,cell.current.deps[i])))cell.current={value:factory(),deps};return cell.current.value}
  return{RawFramesRead:Read,clampFrameLimit,RawFramesStatus,CommunicationSummary:Summary,DiagnosticsCleanupButton:Cleanup,
   useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),useSyncExternalStore:(subscribe,snapshot)=>{hooks.useEffect(()=>subscribe(()=>{}),[subscribe]);return snapshot()},
   fetchRawFrames:(url,signal)=>{const response=deferred();requests.push({url,signal,response});return response.promise},
   setInterval:fn=>{const id=++nextInterval;intervals.set(id,fn);return id},clearInterval:id=>intervals.delete(id),formatLocalTs:value=>value,
  }
 },props,tree=>commits.push(tree))
 const view=()=>driver.one(RawFramesStatus).props,render=()=>{driver.render();driver.render()},settle=async()=>{await tick();render()},pause=()=>{driver.one('button',p=>p['aria-pressed']!==undefined).props.onClick();render()},refresh=()=>{driver.one('button',p=>p.disabled!==undefined&&p['aria-pressed']===undefined).props.onClick();render()},focus=active=>{const status=RawFramesStatus(view()),walk=node=>Array.isArray(node)?node.flatMap(walk):React.isValidElement(node)?[node,...walk(node.props.children)]:[];const checkbox=walk(status).find(node=>node.type==='input'&&node.props.type==='checkbox');assert(checkbox);checkbox.props.onChange({target:{checked:active}});render()}
 return{driver,requests,intervals,readers,commits,view,render,settle,pause,refresh,focus,html:()=>renderToStaticMarkup(driver.tree),update:next=>{props={...props,device:next};driver.render(props);driver.render()},spam:()=>{for(let i=0;i<20;i++)for(const fn of [...intervals.values()])fn();render()},async close(){driver.dispose();for(const q of requests)q.response.resolve([]);await tick();assert.equal(intervals.size,0);assert.equal(driver.lateWrites,0)}}
}
let cases=0
async function check(name,run){await run();cases++;console.log('RAW COMPOSITION OK: '+name)}
for(const english of [false,true])for(const lateError of [false,true]){
 await check('rapid refresh/pause/filter/late '+english+'/'+lateError,async()=>{const h=harness(english);try{
  await h.settle();assert.equal(h.requests.length,1);h.spam();h.refresh();await h.settle();assert.equal(h.requests.length,1)
  const a=frames(device,0xA1);h.requests[0].response.resolve(a);await h.settle();h.focus(true);assert.equal(h.view().exceptionFocus.shown,1);const original=h.view().state.value
  h.refresh();await h.settle();assert.equal(h.requests.length,2);h.focus(false);h.spam();h.focus(true);await h.settle();assert.equal(h.requests.length,2)
  h.pause();assert(h.requests[1].signal.aborted);assert.equal(h.intervals.size,0);h.refresh();h.spam();await h.settle();assert.equal(h.requests.length,2)
  if(lateError)h.requests[1].response.reject(Error('PRIVATE obsolete A'));else h.requests[1].response.resolve(frames(device,0xE1))
  await h.settle();assert.equal(h.view().state.value,original);assert.equal(h.view().paused,true);assert.equal(h.view().exceptionFocus.shown,1);assert(!h.html().includes('PRIVATE'))
  h.pause();await h.settle();assert.equal(h.requests.length,3);h.requests[2].response.resolve(frames(device,0xA2,false));await h.settle();assert.equal(h.view().exceptionFocus.shown,0)
  assert(h.html().includes(english?'No matches':'当前快照未匹配'));assert(h.html().includes(english?'does not mean no communication errors':'不等于没有通信错误'))
  h.focus(false);assert.equal(h.view().exceptionFocus.shown,1)
 }finally{await h.close()}})
 await check('source change while paused and same-ID delayed replacement '+english+'/'+lateError,async()=>{const h=harness(english);try{
  await h.settle();h.requests[0].response.resolve(frames(device,0xA3));await h.settle();h.focus(true);const oldControl=h.view().exceptionFocus
  h.refresh();await h.settle();const old=h.requests[1];h.pause()
  const b={id:2,name:'Mock B',transport:'rtu',serialPath:'MOCK_B'};h.update(b);assert.equal(h.view().state.value,undefined);assert.equal(h.view().exceptionFocus.active,false);assert.equal(h.view().paused,true)
  oldControl.change(true);h.render();assert.equal(h.view().exceptionFocus.active,false);await h.settle();assert.equal(h.requests.length,2,'source change while paused cannot read')
  h.pause();await h.settle();assert.equal(h.requests.length,3);assert(h.requests[2].url.includes('/2/'))
  h.requests[2].response.resolve(frames(b,0xB3));if(lateError)old.response.reject(Error('PRIVATE old source'));else old.response.resolve(frames(device,0xE3))
  await h.settle();assert.equal(h.view().state.value.frames[0].transport,'rtu');assert.equal(h.view().exceptionFocus.shown,2);assert(!h.html().includes('E3'));h.focus(true);assert.equal(h.view().exceptionFocus.shown,1)
  h.refresh();await h.settle();const oldB=h.requests[3];const next={...b,serialPath:'MOCK_C'};h.update(next);assert.equal(h.view().state.value,undefined);assert.equal(h.view().exceptionFocus.active,false);await h.settle();assert(oldB.signal.aborted)
  const current=h.requests[4];assert.equal(current.url,oldB.url,'same-ID URL has independent reader ownership');current.response.resolve(frames(next,0xC3));oldB.response.resolve(frames(b,0xE4));await h.settle();assert.equal(h.view().state.phase,'ready');assert(h.view().state.value.frames[0].hex.endsWith('C3'));assert(!h.html().includes('E4'))
 }finally{await h.close()}})
 await check('A/B/A plus same-ID TCP/limit replacements and dispose '+english+'/'+lateError,async()=>{const h=harness(english);try{
  await h.settle();const old=h.requests[0];h.update({...device,id:3,name:'Mock C'});await h.settle();const c=h.requests[1]
  h.update({...device,ip:'second.mock.invalid'});await h.settle();const a=h.requests[2];assert.equal(h.view().state.value,undefined);assert(old.signal.aborted);assert(c.signal.aborted)
  a.response.resolve(frames(device,0xA4));old.response.resolve(frames(device,0xE5));if(lateError)c.response.reject(Error('old C'));else c.response.resolve(frames({...device,id:3},0xE6));await h.settle();assert(h.view().state.value.frames[0].hex.endsWith('A4'))
  h.focus(true);h.refresh();await h.settle();const beforeLimit=h.requests[3];h.pause();h.driver.one('input',p=>p.type==='number').props.onChange({target:{value:'20'}});h.render();assert.equal(h.view().state.value,undefined);assert.equal(h.view().exceptionFocus.active,false);h.pause();await h.settle();assert(h.requests[4].url.endsWith('limit=20'))
  h.requests[4].response.resolve(frames(device,0xA5));beforeLimit.response.resolve(frames(device,0xE7));await h.settle();assert(h.view().state.value.frames[0].hex.endsWith('A5'));h.focus(true);h.refresh();await h.settle();const pending=h.requests[5];h.driver.dispose();assert(pending.signal.aborted);pending.response.resolve(frames(device,0xE8));await tick();assert.equal(h.driver.lateWrites,0)
 }finally{await h.close()}})
}
for(const english of [false,true]) await check('segmented records retain full snapshot, pause, filter/source ownership and shrink '+english,async()=>{
 const h=harness(english),walk=node=>Array.isArray(node)?node.flatMap(walk):React.isValidElement(node)?[node,...walk(node.props.children)]:[]
 const rowIds=()=>walk(h.driver.tree).filter(node=>node.type==='div'&&Array.isArray(node.props.children)&&node.props.children[0]?.props?.title&&node.props.children.at(-1)?.type==='span').map(node=>Number(node.key))
 const older=()=>h.driver.one('button',props=>props.children===(english?'Previous 20 records':'前20条')),newer=()=>h.driver.one('button',props=>props.children===(english?'Next 20 records':'后20条'))
 const many=(target,count)=>{const sample=frames(target,0xA1,false)[0];return Array.from({length:count},(_,index)=>({...sample,id:index+1,isException:index%2===0}))}
 let lateControl
 try{
  await h.settle();const raw=many(device,80),original=JSON.stringify(raw);h.requests[0].response.resolve(raw);await h.settle();h.pause()
  const snapshot=h.view().state.value;assert.equal(snapshot.frames.length,80);assert.deepEqual(rowIds(),Array.from({length:20},(_,i)=>61+i));assert(h.html().includes('61–80 / 80'))
  assert(h.html().includes(english?'not a fixed snapshot':'不是固定快照'));assert(h.html().includes(english?'pause page reads':'先暂停页面读取'))
  assert.equal(older().props.type,'button');assert.equal(newer().props.type,'button');assert.equal(newer().props.disabled,true)
  const blocks=[rowIds()]
  while(!older().props.disabled){older().props.onClick();h.render();blocks.push(rowIds())}
  assert.deepEqual(blocks.reverse().flat(),Array.from({length:80},(_,i)=>i+1));assert.equal(h.view().state.value,snapshot);assert.equal(h.requests.length,1)
  newer().props.onClick();h.render();assert.deepEqual(rowIds(),Array.from({length:20},(_,i)=>21+i))
  h.focus(true);assert.equal(h.view().exceptionFocus.shown,40);assert.deepEqual(rowIds(),Array.from({length:20},(_,i)=>41+i*2));const oldFiltered=older().props.onClick
  h.focus(false);older().props.onClick();h.render();assert.deepEqual(rowIds(),Array.from({length:20},(_,i)=>41+i));oldFiltered();h.render();assert.deepEqual(rowIds(),Array.from({length:20},(_,i)=>41+i),'stale filtered-page control cannot reset current selection')
  const oldSource=older().props.onClick,next={...device,ip:'next.mock.invalid'};h.update(next);assert.equal(h.view().state.value,undefined);assert.deepEqual(rowIds(),[]);oldSource();h.render();assert.deepEqual(rowIds(),[]);assert.equal(h.requests.length,1)
  h.pause();await h.settle();h.requests[1].response.resolve(many(next,7));await h.settle();assert.deepEqual(rowIds(),[1,2,3,4,5,6,7]);assert(older().props.disabled&&newer().props.disabled)
  h.refresh();await h.settle();h.requests[2].response.resolve(many(next,80));await h.settle();older().props.onClick();h.render();assert.equal(rowIds()[0],41)
  h.refresh();await h.settle();h.requests[3].response.resolve(many(next,3));await h.settle();assert.deepEqual(rowIds(),[1,2,3]);assert(h.html().includes('1–3 / 3'));assert.equal(JSON.stringify(raw),original)
  h.refresh();await h.settle();h.requests[4].response.resolve(many(next,80));await h.settle();assert.equal(rowIds()[0],61,'growth after a clamped segment must not resurrect the old out-of-range selection')
  const retained=h.view().state.value;h.refresh();await h.settle();h.requests[5].response.reject(Error('PRIVATE synthetic read error'));await h.settle();assert.equal(h.view().state.value,retained);assert.equal(h.view().state.phase,'error');assert.equal(rowIds()[0],61);assert(h.html().includes(english?'Previous captures':'保留上次显示'));assert(!h.html().includes('PRIVATE'))
  older().props.onClick();h.render();assert.equal(rowIds()[0],41);assert.equal(h.requests.length,6,'browsing retained data does not issue a read')
  h.refresh();await h.settle();h.requests[6].response.resolve([]);await h.settle();assert.deepEqual(rowIds(),[]);assert(h.html().includes(english?'This read returned no captures':'本次读取没有返回捕获记录'))
  h.refresh();await h.settle();h.requests[7].response.resolve(many(next,25));await h.settle();assert.equal(rowIds()[0],6);assert(h.html().includes('6–25 / 25'))
  lateControl=older().props.onClick
 }finally{await h.close()}
 lateControl?.();assert.equal(h.driver.lateWrites,0)
})
for(const english of [false,true])for(const transport of ['tcp','rtu']) await check('long segmented snapshots/refresh/filter/pause/shrink '+english+'/'+transport,async()=>{
 const target={...device,transport,serialPath:'MOCK_LONG'},h=harness(english,target)
 const walk=node=>Array.isArray(node)?node.flatMap(walk):React.isValidElement(node)?[node,...walk(node.props.children)]:[]
 const rows=()=>walk(h.driver.tree).filter(node=>node.type==='div'&&Array.isArray(node.props.children)&&node.props.children[0]?.props?.title&&node.props.children.at(-1)?.type==='span')
 const ids=()=>rows().map(node=>Number(node.key)),older=()=>h.driver.one('button',p=>p.children===(english?'Previous 20 records':'前20条')),newer=()=>h.driver.one('button',p=>p.children===(english?'Next 20 records':'后20条'))
 const fixture=(count,offset,tag)=>{const sample=frames(target,tag,false)[0];return Array.from({length:count},(_,index)=>{const bytes=Buffer.alloc(4096,tag);bytes.set(Buffer.from(sample.hex,'hex'));bytes.set([index,0,255],bytes.length-3);return{...sample,id:offset+index+1,hex:bytes.toString('hex').toUpperCase(),byteLength:bytes.length,isException:index%3===0}})}
 const verify=(source)=>{const expected=new Map(source.map(frame=>[frame.id,frame]));assert(rows().length<=20);for(const row of rows()){const frame=expected.get(Number(row.key));assert(frame,'rendered record must belong to the displayed snapshot');const text=row.props.children.at(-1).props.children;assert.equal(text.replace(/\s/g,''),frame.hex);assert.equal(text.length,frame.byteLength*3-1);assert(!text.includes('…')&&!text.includes('...'))}}
 const nextRead=async()=>{const count=h.requests.length;h.refresh();await h.settle();assert.equal(h.requests.length,count+1);return h.requests.at(-1)}
 try{
  await h.settle();const first=fixture(43,0,0xA1),original=JSON.stringify(first);h.requests[0].response.resolve(first);await h.settle();const initial=h.view().state.value
  verify(first);assert.equal(ids()[0],24);older().props.onClick();h.render();assert.equal(ids()[0],4);const oldControl=older().props.onClick
  const delayed=await nextRead();h.focus(true);assert.equal(h.view().exceptionFocus.shown,15);assert.deepEqual(ids(),first.filter(frame=>frame.isException).map(frame=>frame.id));verify(first)
  h.pause();assert(delayed.signal.aborted);const pausedRequests=h.requests.length;h.spam();h.refresh();await h.settle();assert.equal(h.requests.length,pausedRequests)
  if(transport==='tcp')delayed.response.resolve(fixture(57,100,0xB1));else delayed.response.reject(Error('PRIVATE obsolete long capture'))
  await h.settle();assert.equal(h.view().state.value,initial);assert.equal(h.view().paused,true);assert.equal(h.view().exceptionFocus.shown,15);verify(first);assert(!h.html().includes('PRIVATE'))
  h.focus(false);older().props.onClick();h.render();const selected=ids();oldControl();h.render();assert.deepEqual(ids(),selected);verify(first)
  while(!newer().props.disabled){newer().props.onClick();h.render()}
  const blocks=[];do{verify(first);blocks.push(ids());if(older().props.disabled)break;older().props.onClick();h.render()}while(true)
  assert.deepEqual(blocks.reverse().flat(),first.map(frame=>frame.id));assert.equal(h.view().state.value,initial);assert.equal(h.requests.length,pausedRequests)
  h.pause();await h.settle();const second=fixture(57,100,0xB1);h.requests.at(-1).response.resolve(second);await h.settle();assert.equal(ids()[0],101);assert.equal(ids().length,17);verify(second);assert(h.html().includes(english?'not a fixed snapshot':'不是固定快照'))
  newer().props.onClick();h.render();assert.equal(ids()[0],118);verify(second);h.focus(true);assert.equal(h.view().exceptionFocus.shown,19);verify(second)
  h.focus(false);older().props.onClick();h.render();older().props.onClick();h.render();assert.equal(ids()[0],101)
  const shrinkRead=await nextRead(),small=fixture(9,200,0xC1);shrinkRead.response.resolve(small);await h.settle();assert.deepEqual(ids(),small.map(frame=>frame.id));verify(small)
  h.pause();h.pause();await h.settle();const grown=fixture(57,300,0xD1);h.requests.at(-1).response.resolve(grown);await h.settle();assert.equal(ids()[0],338,'resume after shrink keeps the adjusted segment, not the old index');verify(grown)
  const invalidRead=await nextRead(),retained=h.view().state.value;invalidRead.response.resolve([...grown.slice(0,-1),{...grown.at(-1),hex:grown.at(-1).hex.slice(0,-2)}]);await h.settle()
  assert.equal(h.view().state.phase,'error');assert.equal(h.view().state.value,retained);verify(grown);assert(h.html().includes(english?'Previous captures':'保留上次显示'))
  const emptyRead=await nextRead();emptyRead.response.resolve([]);await h.settle();assert.deepEqual(ids(),[]);assert(h.html().includes(english?'This read returned no captures':'本次读取没有返回捕获记录'))
  assert.equal(JSON.stringify(first),original)
 }finally{await h.close()}
})
console.log(`RAW COMPOSITION AUDIT OK: ${cases} bilingual delayed-response/refresh/pause/filter/source/limit/unmount/segment combinations; actual extracted view callbacks, real reader, virtual intervals and mock GET only. React DOM, native event scheduling, backend physical identity and real devices not proven.`)
const {apply}=await load('packages/poller/src/index.ts')
const apiSource=ts.createSourceFile('api.ts',readFileSync(new URL('../packages/api/src/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
let frameRoute
const findRoute=node=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='get'&&node.arguments[0]?.text==='/api/monitor_objects/:id/frames')frameRoute=node.arguments[1];ts.forEachChild(node,findRoute)};findRoute(apiSource);assert(frameRoute)
const routeFor=engine=>Function('poller',ts.transpile('return ('+frameRoute.getText(apiSource)+')',{target:ts.ScriptTarget.ES2022}))(engine)
let bindingCases=0
for(const [transport,patch] of [['tcp',{ip:'after.mock.invalid'}],['tcp',{port:1502}],['rtu',{baudRate:19200}],['rtu',{parity:'even'}],['rtu',{stopBits:2}],['rtu',{dataBits:7}],['rtu',{flowControl:'rtscts'}]]){
 let object={...device,mode:'master',transport,serialPath:'MOCK_BOUND',baudRate:9600,parity:'none',stopBits:1,dataBits:8,flowControl:'none'},engine,connects=0,disconnects=0,getters=0,forbidden=0,insideGet
 apply({config:{getObject:id=>object?.id===id?{...object}:null,listGroups:()=>[{slaveId:1}]},store:{write(){forbidden++}},modbus:{createDriver:(kind,identity)=>{
  const diag=new ModbusDiagnostics(kind,2000,identity);let connected=false
  return{isConnected:()=>connected,async connect(){connected=true;connects++;const header=kind==='tcp'?[0,1,0,0,0,3,1]:[1];diag.recordFrame('rx',Uint8Array.from([...header,0x83,connects===1?0xA1:0xB1]))},async disconnect(){disconnects++;connected=false},getFrames(limit){getters++;const value=diag.getFrames(limit);insideGet?.();return value},readHoldingRegisters(){forbidden++},writeRegister(){forbidden++},clearDiagnostics(){forbidden++}}
 }},on(){},provide(_name,value){engine=value},emit(){forbidden++}}, {pollIntervalMs:0,connectRetryMs:0,watchdogTimeoutMs:30000,autoResetFailThreshold:0,autoResetCooldownMs:0})
 const app=Fastify();app.get('/api/monitor_objects/:id/frames',routeFor(engine))
 const read=async(url)=>{const response=await app.inject(url);if(response.statusCode!==200){assert(!response.body.includes('.mock.invalid'));throw Error('mock GET failed')}return response.json()}
 try{
  const driver=await engine.getDriver(object),key=engine.driverKey(object),original={...object},first=new RawFramesRead(object,200)
  await first.refresh(read);assert.equal(first.snapshot().phase,'ready');const accepted=first.snapshot().value;assert.equal(accepted.frames[0].exceptionCode,0xA1)
  object={...object,name:'metadata only',pollIntervalMs:77};assert.equal(engine.getDeviceFrames(1,200)[0].exceptionCode,0xA1)
  object={...object,...patch};const beforeGetters=getters,newReader=new RawFramesRead(object,200)
  await newReader.refresh(read);assert.equal(newReader.snapshot().phase,'error','known old driver buffer must not be accepted as a successful current-source capture read');assert.equal(newReader.snapshot().value,undefined)
  await first.refresh(read);assert.equal(first.snapshot().phase,'error');assert.equal(first.snapshot().value,accepted,'existing display becomes explicitly stale, never a current success')
  for(const english of [false,true]){const html=renderToStaticMarkup(React.createElement(RawFramesStatus,{state:first.snapshot(),paused:true,english,exceptionFocus:{active:true,shown:1,change(){}}}));assert(html.includes(english?'Current backend state is unverified':'当前后台状态未核实'));assert(html.includes(english?'Previous captures':'保留上次显示'));assert(html.includes(english?'timeouts/connection errors':'超时/连接错误'))}
  assert.equal(getters,beforeGetters,'binding refusal happens before reading the old buffer');assert.equal(connects,1);assert.equal(disconnects,0)
  object={...original};engine.driverBindings.delete(driver);assert.throws(()=>engine.getDeviceFrames(1,200),/已变化/,'unknown binding must be refused, not guessed');assert.equal(getters,beforeGetters);engine.driverBindings.set(driver,engine.connectionSignature(object))
  for(const action of ['source','delete','driver']){
   object={...original};engine.drivers.set(key,driver)
   insideGet=()=>{if(action==='source')object={...object,...patch};if(action==='delete')object=null;if(action==='driver')engine.drivers.set(key,{getFrames:()=>[]})}
   assert.throws(()=>engine.getDeviceFrames(1,200),/已变化/,'reentrant getter change cannot publish the old captured list');insideGet=undefined
  }
  object={...original,...patch};engine.drivers.set(key,driver)
  const next=await engine.getDriver(object);assert.notEqual(next,driver);assert.equal(connects,2);assert.equal(disconnects,1)
  await newReader.refresh(read);assert.equal(newReader.snapshot().phase,'ready');assert.equal(newReader.snapshot().value.frames[0].exceptionCode,0xB1)
  engine.drivers.delete(key);assert.deepEqual(engine.getDeviceFrames(1,200),[],'no driver still means no returned captures, without automatic creation');engine.drivers.set(key,next)
  assert.equal(connects,2);assert.equal(disconnects,1);assert.equal(forbidden,0)
  bindingCases++;console.log('RAW BINDING OK: '+transport+'/'+Object.keys(patch)[0])
 }finally{insideGet=undefined;await app.close();await engine.stopAll()}
}
console.log(`RAW BINDING TEST OK: ${bindingCases} same-key TCP/RTU setting changes; actual driver ownership, unknown binding refusal, pre/post memory-read checks, metadata compatibility, stale-display warnings and explicit mock recovery; getters never reconnect or write. No frontend expected-version or physical-origin guarantee.`)
