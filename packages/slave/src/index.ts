import { DeviceSlaves } from './devices.ts'
import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { SerialPort } from 'serialport'
import { SlaveMemory, RtuSlaveSession, type SlaveArea } from './protocol.ts'
export const name = 'slave'
export interface Config { port: number; holdingSize: number }
export const Config: z<Config> = z.object({ port: z.number().default(8502), holdingSize: z.number().default(5000) })
export type Transport = 'tcp' | 'rtu'
export type SlaveOptions = { host: string; port: number; unitId: number; serialPath: string; baudRate: number; parity: 'none' | 'even' | 'odd'; dataBits: 8; stopBits: 1 | 2; flowControl?: string }
const defaults: SlaveOptions = { host: '0.0.0.0', port: 8502, unitId: 1, serialPath: '', baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1 }
export class ModbusSlave {
  readonly memory: SlaveMemory
  private tcp?: net.Server
  private serial?: any
  private sockets = new Set<net.Socket>()
  private busy = new Set<Transport>()
  private states = { tcp: { running: false, error: '', requests: 0, lastRequest: null as string | null, options: { ...defaults } }, rtu: { running: false, error: '', requests: 0, lastRequest: null as string | null, options: { ...defaults } } }
  constructor(config: Config, private portCtor: any = SerialPort) { this.memory = new SlaveMemory(config.holdingSize); this.states.tcp.options.port = config.port }
  status() { return { size: this.memory.size, connections: this.sockets.size, tcp: { ...this.states.tcp, busy: this.busy.has('tcp') }, rtu: { ...this.states.rtu, busy: this.busy.has('rtu') } } }
  private received(transport: Transport) { this.states[transport].requests++; this.states[transport].lastRequest = new Date().toISOString() }
  private validate(transport: Transport, fields: Partial<SlaveOptions>) {
    const options = { ...this.states[transport].options, ...fields }
    const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max
    if (!integer(options.unitId, 1, 247) || transport === 'tcp' && (!integer(options.port, 1, 65535) || (typeof options.host !== 'string' || !net.isIP(options.host))) || transport === 'rtu' && ((typeof options.serialPath !== 'string' || !options.serialPath.trim()) || !integer(options.baudRate, 300, 4000000) || !['none', 'even', 'odd'].includes(options.parity) || options.dataBits !== 8 || ![1, 2].includes(options.stopBits))) throw Object.assign(new Error('从站通信参数无效'), { statusCode: 400 })
    return options
  }
  async start(transport: Transport = 'tcp', fields: Partial<SlaveOptions> = {}) {
    if (this.busy.has(transport)) throw Object.assign(new Error('从站正在启停，请稍候'), { statusCode: 409 })
    if (this.states[transport].running) throw Object.assign(new Error('请先停止从站，再修改通信参数'), { statusCode: 409 })
    const options = this.validate(transport, fields), state = this.states[transport]
    this.busy.add(transport); state.error = ''
    try {
      if (transport === 'tcp') {
        const server = net.createServer(socket => {
          this.sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => this.sockets.delete(socket))
          let pending = Buffer.alloc(0)
          socket.on('data', data => {
            pending = Buffer.concat([pending, data])
            while (pending.length >= 7) {
              const length = pending.readUInt16BE(4)
              if (pending.readUInt16BE(2) !== 0 || length < 2 || length > 254) { socket.destroy(); return }
              if (pending.length < length + 6) break
              const frame = pending.subarray(0, length + 6); pending = pending.subarray(length + 6)
              if (frame[6] !== options.unitId) continue
              const pdu = this.memory.respond(frame.subarray(7)), header = Buffer.from(frame.subarray(0, 7))
              header.writeUInt16BE(pdu.length + 1, 4); socket.write(Buffer.concat([header, pdu])); this.received('tcp')
            }
            if (pending.length > 260) socket.destroy()
          })
        })
        this.tcp = server
        server.on('error', (e: any) => { state.error = e.code === 'EADDRINUSE' ? `端口 ${options.port} 已被占用` : e.message; state.running = false })
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve() }) })
      } else {
        const serial = new this.portCtor({ path: options.serialPath.trim(), baudRate: options.baudRate, parity: options.parity, dataBits: options.dataBits, stopBits: options.stopBits, rtscts: options.flowControl === 'rtscts', xon: options.flowControl === 'xonxoff', xoff: options.flowControl === 'xonxoff', autoOpen: false })
        this.serial = serial
        let timer: ReturnType<typeof setTimeout> | undefined
        const session = new RtuSlaveSession(this.memory, options.unitId, frame => serial.write(frame, (e: Error | null) => { if (e) state.error = e.message }), () => this.received('rtu'))
        serial.on('data', (data: Buffer) => {
          if (timer) clearTimeout(timer)
          session.feed(data)
          timer = setTimeout(() => session.reset(), Math.max(5, Math.ceil(3.5 * 11 * 1000 / options.baudRate)))
        })
        serial.on('error', (e: Error) => { state.error = e.message })
        serial.on('close', () => { state.running = false; if (timer) clearTimeout(timer); session.reset() })
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { reject(new Error('串口打开超时')); serial.once('open', () => serial.close(() => {})) }, 5000)
          serial.open((error: Error | null) => { clearTimeout(timeout); error ? reject(error) : resolve() })
        })
      }
      state.options = options; state.running = true
    } catch (e: any) { state.running = false; state.error ||= e.message; throw Object.assign(new Error(state.error), { statusCode: 400, code: e.code }) }
    finally { this.busy.delete(transport) }
    return this.status()
  }
  async stop(transport: Transport = 'tcp') {
    if (this.busy.has(transport)) throw Object.assign(new Error('从站正在启停，请稍候'), { statusCode: 409 })
    this.busy.add(transport)
    try {
      if (transport === 'tcp') {
        for (const socket of this.sockets) socket.destroy()
        if (this.tcp?.listening) await new Promise<void>((resolve, reject) => this.tcp!.close(e => e ? reject(e) : resolve()))
        this.tcp = undefined
      } else {
        if (this.serial?.isOpen) await new Promise<void>((resolve, reject) => this.serial.close((e: Error | null) => e ? reject(e) : resolve()))
        this.serial = undefined
      }
      this.states[transport].running = false; this.states[transport].error = ''
    } finally { this.busy.delete(transport) }
    return this.status()
  }
  read(area: SlaveArea, address: number, count: number) { return Array.from(this.memory.range(area, address, count)) }
  write(area: SlaveArea, address: number, values: number[]) { this.memory.write(area, address, values) }
  setRegister(address: number, value: number) { this.write('holding-register', address, [value]) }
  getRegister(address: number) { return this.read('holding-register', address, 1)[0] }
}
export function apply(ctx: Context, config: Config): void {
  const slave = new ModbusSlave(config)
  ctx.provide('slave', slave)
  const configStore = ctx.get('config', false), store = ctx.get('store', false)
  const devices = configStore && store ? new DeviceSlaves(configStore, store, (event, data) => (ctx as any).emit(event, data)) : null
  if (devices) { ctx.provide('deviceSlaves', devices); devices.start() }
  void slave.start().then(() => ctx.logger('slave').info(`slave listening on 0.0.0.0:${config.port}`)).catch((e: Error) => ctx.logger('slave').error(e.message))
  ctx.effect(() => async () => { await slave.stop('tcp'); await slave.stop('rtu'); await devices?.stop() })
}
