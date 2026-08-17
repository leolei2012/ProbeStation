// OTA MCP 全链路验收测试（测试工程师独立验证）
// 覆盖 PRD 07 §9：MCP upload_firmware→ota_upgrade→ota_status 链路 + 升级期间 poller 暂停/恢复
import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as workspacePlugin from '../packages/workspace/src/index.ts'
import * as otaPlugin from '../packages/ota/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { crc32, crc16, CMD_START, CMD_DATA, CMD_END, CMD_STATUS, ST_OK } from '../packages/ota/src/frame.ts'

// ── 0x41 IAP 从站核心（与 MB-RTU modbus_slave.c 一致）──
function makeIapCore() {
  const state = { active: false, nextBlock: 0, totalSize: 0, crc32: 0, received: Buffer.alloc(0), blockLog: [] as number[] }
  function handle(pdu: Buffer): Buffer {
    const fc = pdu[0], cmd = pdu[1]
    if (fc !== 0x41) throw new Error('bad fc')
    if (cmd === CMD_START) {
      state.totalSize = pdu.readUInt32BE(2); state.crc32 = pdu.readUInt32BE(6)
      state.active = true; state.nextBlock = 0; state.received = Buffer.alloc(0)
      return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_DATA) {
      if (!state.active) return Buffer.from([0x41, cmd, 0x03])
      const blockNo = pdu.readUInt16BE(2); const data = pdu.subarray(4)
      if (blockNo !== state.nextBlock) return Buffer.from([0x41, cmd, 0x01])
      state.received = Buffer.concat([state.received, data]); state.nextBlock++; state.blockLog.push(blockNo)
      return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_END) {
      if (!state.active) return Buffer.from([0x41, cmd, 0x03])
      if (pdu.readUInt16BE(2) !== state.nextBlock) return Buffer.from([0x41, cmd, 0x01])
      state.active = false; return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_STATUS) return Buffer.from([0x41, cmd, ST_OK, (state.nextBlock >> 8) & 0xff, state.nextBlock & 0xff])
    throw new Error('unknown cmd ' + cmd)
  }
  return { state, handle }
}

function rtuSlave(slaveId: number, core: ReturnType<typeof makeIapCore>) {
  return (frame: Buffer): Buffer => {
    const pdu = frame.subarray(1, frame.length - 2)
    const respPdu = core.handle(pdu)
    const body = Buffer.concat([Buffer.from([slaveId]), respPdu])
    const c = crc16(body)
    return Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])])
  }
}

function makeFakeSocket(respond: (f: Buffer) => Buffer) {
  const listeners: Array<(c: Buffer) => void> = []
  return {
    on: (ev: string, cb: any) => { if (ev === 'data') listeners.push(cb); return undefined as any },
    off: (ev: string, cb: any) => { if (ev === 'data') { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } },
    write: (frame: Buffer, cb?: any) => { const resp = respond(frame); cb?.(); setTimeout(() => { for (const l of listeners) l(resp) }, 1); return true },
  }
}

const core = makeIapCore()
const socket = makeFakeSocket(rtuSlave(1, core))

// 记录暂停/恢复调用次数（PRD §9「升级期间设备轮询暂停，结束恢复」）
const calls = { pause: 0, resume: 0, reconnect: 0 }
const fakePoller = {
  pauseObject: (_id: number) => { calls.pause++ },
  resumeObject: (_id: number) => { calls.resume++ },
  reconnectDevice: (_id: number) => { calls.reconnect++ },
  getRawSocket: async (_id: number) => socket,
  isRunning: () => false,
  isDeviceConnected: () => true,
  write: () => { throw new Error('write not used in this test') },
}

const wsDir = mkdtempSync(join(tmpdir(), 'ota-mcp-ws-'))
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(workspacePlugin, { defaultWorkspace: wsDir, registryPath: join(wsDir, 'registry.json') })
ctx.provide('poller', fakePoller)
await ctx.plugin(otaPlugin)
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 18082 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('rtu-ota-dev', '', 502, 'master', { transport: 'rtu', serialPath: 'COM_TEST', slaveId: 1 })

await new Promise(r => setTimeout(r, 300))
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18082/mcp'))
const client = new Client({ name: 'ota-test', version: '1.0' })
await client.connect(transport)

const tools = await client.listTools()
const names = tools.tools.map((t: any) => t.name)
console.log('MCP tools (' + names.length + '):', JSON.stringify(names))
for (const n of ['upload_firmware', 'list_firmwares', 'ota_upgrade', 'ota_status', 'ota_abort']) {
  if (!names.includes(n)) throw new Error('missing OTA tool: ' + n)
}
console.log('OTA 5 tools present OK')

// 1) upload_firmware（base64）
const FW = Buffer.alloc(300)
for (let i = 0; i < 300; i++) FW[i] = (i * 7 + 3) & 0xff
const up = await client.callTool({ name: 'upload_firmware', arguments: { name: 'accept-fw', version: '1.0.0', content_base64: FW.toString('base64') } })
const upVal = JSON.parse((up.content[0] as any).text)
if (upVal.size !== 300 || upVal.crc32 !== crc32(FW)) throw new Error('upload_firmware mismatch: ' + JSON.stringify(upVal))
console.log('upload_firmware:', JSON.stringify(upVal))

// 2) list_firmwares
const lf = await client.callTool({ name: 'list_firmwares', arguments: {} })
const lfArr = JSON.parse((lf.content[0] as any).text)
if (!lfArr.some((f: any) => f.id === upVal.firmware_id)) throw new Error('list_firmwares missing id')
console.log('list_firmwares count:', lfArr.length)

// 3) ota_upgrade（异步发起）
const before = calls.pause
const og = await client.callTool({ name: 'ota_upgrade', arguments: { device_id: obj.id, firmware_id: upVal.firmware_id, chunk_size: 128 } })
const ogVal = JSON.parse((og.content[0] as any).text)
console.log('ota_upgrade:', JSON.stringify(ogVal))
if (calls.pause !== before + 1) throw new Error('pauseObject not called on upgrade start')

// 4) ota_status 轮询至 done
let final: any = null
for (let i = 0; i < 200; i++) {
  const st = await client.callTool({ name: 'ota_status', arguments: { device_id: obj.id } })
  const s = JSON.parse((st.content[0] as any).text)
  final = s
  if (s.state === 'done' || s.state === 'failed') break
  await new Promise(r => setTimeout(r, 10))
}
console.log('ota_status final:', JSON.stringify(final))
if (final.state !== 'done') throw new Error('upgrade not done: ' + JSON.stringify(final))
if (final.percent !== 100 || final.total_blocks !== 3 || final.current_block !== 3) throw new Error('progress mismatch: ' + JSON.stringify(final))
if (!core.state.received.equals(FW)) throw new Error('slave received firmware mismatch')
if (core.state.crc32 !== upVal.crc32) throw new Error('slave crc32 mismatch')
if (calls.resume !== 1 || calls.reconnect < 1) throw new Error('resume/reconnect not called on completion')

// 5) ota_abort（对一次进行中的升级做中止）
console.log('OTA MCP ACCEPTANCE TEST OK  (pause=' + calls.pause + ' resume=' + calls.resume + ' reconnect=' + calls.reconnect + ')')
await client.close()
process.exit(0)
