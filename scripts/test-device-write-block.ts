import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Context } from 'cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import * as configPlugin from '../packages/config/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { toolRegistrar } from '../packages/mcp/src/tool-registrar.ts'

async function restartProbe() {
  const app = Fastify(), forbidden = () => { throw Error('blocked route touched a dependency') }
  registerRegisterWrite(app, { getRegister: forbidden, getGroup: forbidden, log: forbidden }, { write: forbidden })
  try { for (let i = 0; i < 3; i++) { const result = await app.inject({ method: 'POST', url: '/api/registers/1/write', payload: { value: 42 } }); assert.equal(result.statusCode, 503); assert.equal(result.json().code, 'DEVICE_WRITE_BLOCKED') } } finally { await app.close() }
}
{
  assert.equal(process.argv.length, 2)
  await restartProbe()
  const base = resolve(tmpdir()), directory = mkdtempSync(join(base, 'probe-write-block-')), ctx = new Context(); let effects = 0
  const forbidden = () => { effects++; throw Error('unexpected mock dispatch') }
  try {
    await ctx.plugin(configPlugin, { dbPath: ':memory:' })
    await ctx.plugin({ name: 'inert-block-services', apply(context: Context) { context.provide('poller', { write: forbidden } as any); context.provide('ota', { startUpgrade: forbidden } as any); context.provide('slave', { write: forbidden, status: () => ({ synthetic: true }), read: () => [0] } as any); for (const name of ['store','sink','importer']) context.provide(name as any, {} as any) } })
    await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: directory }); const app = ctx.get('api', false)!
    const cfg = ctx.get('config', false)!, device = cfg.createObject('synthetic', 'mock.invalid', 502)
    for (const phase of ['initial', 'configuration-change', 'repeated-attempt']) {
      if (phase === 'configuration-change') cfg.updateObject(device.id, { ip: 'changed.mock.invalid' })
      for (const [method,url,payload] of [['POST','/api/registers/1/write',{value:42}],['PUT','/api/slave/values',{area:'holding-register',address:0,values:[42]}],['POST','/api/ota/upgrade',{device_id:device.id,firmware_id:1}]] as const) {
        const response = await app.inject({method,url,payload}); assert.equal(response.statusCode,503); assert.equal(response.json().code,'DEVICE_WRITE_BLOCKED'); assert.equal(response.json().retryable,false); assert.equal(response.headers['cache-control'],'no-store')
      }
    }
    assert.equal((await app.inject('/health')).statusCode,200); assert.equal((await app.inject('/api/slave/values?area=holding-register&address=0&count=1')).statusCode,200); assert.equal(effects,0)
    for (let generation=0;generation<2;generation++) {
      const server = new McpServer({name:'synthetic-block',version:'1'}), client = new Client({name:'synthetic-block',version:'1'}), tools=toolRegistrar(server)
      for (const name of ['write_register','ota_upgrade']) tools.registerTool(name,{inputSchema:{}},forbidden)
      tools.registerTool('read_synthetic',{inputSchema:{}},()=>({content:[{type:'text',text:'read retained'}]}))
      const [local,remote]=InMemoryTransport.createLinkedPair()
      try { await Promise.all([server.connect(remote),client.connect(local)]); for (const name of ['write_register','ota_upgrade']) for(let i=0;i<3;i++){const result:any=await client.callTool({name,arguments:{}}); assert.equal(result.isError,true); assert.equal(JSON.parse(result.content[0].text).code,'DEVICE_WRITE_BLOCKED')}; assert.equal((await client.callTool({name:'read_synthetic',arguments:{}})).isError,undefined) }
      finally { await client.close(); await server.close() }
    }
    for(let i=0;i<2;i++){const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/device-write-restart.ts',import.meta.url))],{encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,PROBESTATION_ALLOW_DEVICE_WRITE:'1'}}); assert.equal(child.status,0,String(child.error??'')+child.stderr); assert(child.stdout.includes('fresh process closed'))}
    assert.equal(effects,0)
  } finally { await ctx.fiber.dispose(); const inside=relative(base,resolve(directory)); assert(inside.startsWith('probe-write-block-')&&!inside.includes('/')&&!inside.includes('\\')); rmSync(directory,{recursive:true}) }
  console.log('DEVICE WRITE BLOCK TEST OK: actual API assembly, SDK memory tools, repeated/config-change/session/restart refusal; zero mock dispatch; no real hardware, data or listener')
}
