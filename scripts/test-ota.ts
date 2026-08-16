import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../packages/config/src/index.ts'
import { OtaEngine } from '../packages/ota/src/engine.ts'
import { crc32, crc16, CMD_START, CMD_DATA, CMD_END, CMD_STATUS, ST_OK, ST_BAD_BLOCK } from '../packages/ota/src/frame.ts'

// ── 0x41 IAP 从站核心（PDU 级状态机，与 MB-RTU modbus_slave.c 一致）──
function makeIapCore(failBlockOnce?: number) {
  const state = { active: false, nextBlock: 0, totalSize: 0, crc32: 0, received: Buffer.alloc(0), blockLog: [] as number[], failOnce: failBlockOnce }
  function handle(pdu: Buffer): Buffer {
    const fc = pdu[0], cmd = pdu[1]
    if (fc !== 0x41) throw new Error('bad fc')
    if (cmd === CMD_START) {
      state.totalSize = pdu.readUInt32BE(2)
      state.crc32 = pdu.readUInt32BE(6)
      state.active = true; state.nextBlock = 0; state.received = Buffer.alloc(0)
      return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_DATA) {
      if (!state.active) return Buffer.from([0x41, cmd, 0x03])
      const blockNo = pdu.readUInt16BE(2)
      const data = pdu.subarray(4)
      if (blockNo !== state.nextBlock) return Buffer.from([0x41, cmd, ST_BAD_BLOCK])
      if (state.failOnce === blockNo) { state.failOnce = undefined; return Buffer.from([0x41, cmd, ST_BAD_BLOCK]) }
      state.received = Buffer.concat([state.received, data])
      state.nextBlock++; state.blockLog.push(blockNo)
      return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_END) {
      if (!state.active) return Buffer.from([0x41, cmd, 0x03])
      if (pdu.readUInt16BE(2) !== state.nextBlock) return Buffer.from([0x41, cmd, ST_BAD_BLOCK])
      state.active = false
      return Buffer.from([0x41, cmd, ST_OK])
    }
    if (cmd === CMD_STATUS) return Buffer.from([0x41, cmd, ST_OK, (state.nextBlock >> 8) & 0xff, state.nextBlock & 0xff])
    throw new Error('unknown cmd ' + cmd)
  }
  return { state, handle }
}

// RTU 从站：addr + pdu + crc16
function rtuSlave(slaveId: number, core: ReturnType<typeof makeIapCore>) {
  return (frame: Buffer): Buffer => {
    const pdu = frame.subarray(1, frame.length - 2)
    const respPdu = core.handle(pdu)
    const body = Buffer.concat([Buffer.from([slaveId]), respPdu])
    const c = crc16(body)
    return Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])])
  }
}

// TCP 从站：MBAP(7B) + pdu
function tcpSlave(unitId: number, core: ReturnType<typeof makeIapCore>) {
  return (frame: Buffer): Buffer => {
    const tx = frame.readUInt16BE(0)
    const pdu = frame.subarray(7)
    const respPdu = core.handle(pdu)
    const resp = Buffer.alloc(7 + respPdu.length)
    resp.writeUInt16BE(tx, 0)
    resp.writeUInt16BE(0, 2)
    resp.writeUInt16BE(1 + respPdu.length, 4)
    resp[6] = unitId
    respPdu.copy(resp, 7)
    return resp
  }
}

function makeFakeSocket(respond: (f: Buffer) => Buffer) {
  const listeners: Array<(c: Buffer) => void> = []
  return {
    on: (ev: string, cb: any) => { if (ev === 'data') listeners.push(cb); return this },
    off: (ev: string, cb: any) => { if (ev === 'data') { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } },
    write: (frame: Buffer, cb?: any) => { const resp = respond(frame); cb?.(); setTimeout(() => { for (const l of listeners) l(resp) }, 1); return true },
  }
}

function makeEngine(transport: 'tcp' | 'rtu', respond: (f: Buffer) => Buffer, core: ReturnType<typeof makeIapCore>) {
  const cfg = new ConfigStore({ dbPath: ':memory:' })
  if (transport === 'rtu') cfg.createObject('rtu-test', '', 502, 'master', { transport: 'rtu', serialPath: 'COM_TEST', slaveId: 1 })
  else cfg.createObject('tcp-test', '127.0.0.1', 502, 'master', { transport: 'tcp', slaveId: 1 })
  const fwDir = mkdtempSync(join(tmpdir(), 'ota-test-'))
  const socket = makeFakeSocket(respond)
  const fakeCtx: any = {
    config: cfg,
    workspace: { getCurrent: () => fwDir },
    poller: { pauseObject: () => {}, resumeObject: () => {}, reconnectDevice: () => {}, getRawSocket: async () => socket },
  }
  return { engine: new OtaEngine(fakeCtx), cfg, core }
}

const FW = Buffer.alloc(300)
for (let i = 0; i < 300; i++) FW[i] = (i * 7 + 3) & 0xff

async function runScenario(transport: 'tcp' | 'rtu', core: ReturnType<typeof makeIapCore>, label: string) {
  const respond = transport === 'rtu' ? rtuSlave(1, core) : tcpSlave(1, core)
  const { engine, cfg } = makeEngine(transport, respond, core)
  const up = engine.uploadFirmware('test', '1.0', FW)
  if (up.crc32 !== crc32(FW)) throw new Error('crc32 mismatch')
  const devId = cfg.listObjects()[0].id
  engine.startUpgrade(devId, up.firmware_id, 128)
  for (let i = 0; i < 200; i++) {
    const s: any = engine.getStatus(devId)
    if (s.state === 'done') break
    if (s.state === 'failed') throw new Error('failed: ' + s.error)
    await new Promise((r) => setTimeout(r, 10))
  }
  const s: any = engine.getStatus(devId)
  if (s.state !== 'done') throw new Error(label + ' not done: ' + s.state)
  if (!core.state.received.equals(FW)) throw new Error(label + ' firmware mismatch')
  if (core.state.crc32 !== up.crc32) throw new Error(label + ' slave crc32 mismatch')
  console.log(label + ' 升级完成: ' + FW.length + 'B / ' + core.state.blockLog.length + '块, crc32=0x' + up.crc32.toString(16))
  return core.state.blockLog
}

// 场景 1：RTU 正常流程
await runScenario('rtu', makeIapCore(), '场景1 RTU 正常')
// 场景 2：TCP（MBAP）正常流程
await runScenario('tcp', makeIapCore(), '场景2 TCP 正常')
// 场景 3：RTU 断点续传（block 1 失败一次）
{
  const core = makeIapCore(1)
  const blockLog = await runScenario('rtu', core, '场景3 RTU 断点续传')
  if (!blockLog.includes(1)) throw new Error('block 1 not retried')
  console.log('  blockLog=' + JSON.stringify(blockLog))
}

console.log('OTA TEST OK')
process.exit(0)
