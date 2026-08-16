import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { ModbusTCPClient, ModbusRTUClient } from 'jsmodbus'
import { SerialPort } from 'serialport'

export const name = 'modbus'

export interface Config {
  defaultTimeoutMs: number
  defaultUnitId: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(3000),
  defaultUnitId: z.number().default(1),
})

const EXC_MSG: Record<number, string> = { 1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value', 4: 'Slave Device Failure', 5: 'Acknowledge', 6: 'Slave Device Busy', 8: 'Memory Parity Error', 10: 'Gateway Path Unavailable', 11: 'Gateway Target Failed to Respond' }

/** 连接参数：TCP 用 ip/port，RTU 用 serialPath + 串口参数。 */
export interface ConnectOptions {
  transport?: string
  ip?: string
  port?: number
  serialPath?: string | null
  baudRate?: number
  parity?: string
  stopBits?: number
  dataBits?: number
  flowControl?: string
}

/** 传输无关的 Modbus 驱动抽象。 */
export interface ModbusDriver {
  connect(opts: ConnectOptions): Promise<void>
  disconnect(): void
  isConnected(): boolean
  readHoldingRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  readInputRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  writeRegister(address: number, value: number, slaveId?: number): Promise<void>
  writeRegisters(address: number, values: number[], slaveId?: number): Promise<void>
  /** 返回底层原始 socket（net.Socket / SerialPort），供 OTA 拼 0x41 原始帧直连。 */
  getRawSocket(slaveId?: number): Promise<any>
}

/** 把 jsmodbus 响应 body 转成 16 位字数组。 */
function toValues(body: any): number[] {
  if (body.isException) {
    const code = body.code ?? body.exceptionCode
    throw new Error(EXC_MSG[code] ?? body.message ?? ('Modbus exception ' + code))
  }
  const arr = body.valuesAsArray as number[] | undefined
  return arr ? Array.from(arr) : []
}

/** 把 jsmodbus 抛的 UserRequestError（非 Error 实例）归一化成可读 Error。 */
function normalizeError(e: any): Error {
  if (!e) return new Error('Unknown error')
  if (typeof e.err === 'string') {
    if (e.err === 'Timeout') return new Error('Timeout')
    if (e.err === 'ModbusException') {
      const code = e.response?.body?.code
      return new Error(EXC_MSG[code] ?? 'Modbus exception')
    }
    if (typeof e.message === 'string' && e.message) return new Error(e.message)
    return new Error(e.err)
  }
  if (e instanceof Error) return e
  if (typeof e === 'string') return new Error(e)
  try { return new Error(JSON.stringify(e)) } catch { return new Error('Unknown error') }
}

/** TCP 驱动：每个 slave id（unit id）一个 TCP 连接。 */
class JsmodbusDriver implements ModbusDriver {
  private host = ''
  private port = 0
  private ready = false
  private readonly clients = new Map<number, { socket: net.Socket; client: ModbusTCPClient }>()

  constructor(private readonly config: Config) {}

  async connect(opts: ConnectOptions): Promise<void> {
    this.host = opts.ip ?? ''
    this.port = opts.port ?? 502
    this.ready = true
  }

  disconnect(): void {
    for (const c of this.clients.values()) c.socket.destroy()
    this.clients.clear()
    this.ready = false
  }

  isConnected(): boolean { return this.ready }

  private async getClient(slaveId: number): Promise<ModbusTCPClient> {
    const existing = this.clients.get(slaveId)
    if (existing && !existing.socket.destroyed && existing.socket.writable) return existing.client
    const socket = new net.Socket()
    const client = new ModbusTCPClient(socket, slaveId, this.config.defaultTimeoutMs)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.connect(this.port, this.host)
    })
    this.clients.set(slaveId, { socket, client })
    return client
  }

  async readHoldingRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await (await this.getClient(slaveId)).readHoldingRegisters(address, count)
      return toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async readInputRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await (await this.getClient(slaveId)).readInputRegisters(address, count)
      return toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async writeRegister(address: number, value: number, slaveId = 1): Promise<void> {
    try {
      const res = await (await this.getClient(slaveId)).writeSingleRegister(address, value)
      toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async writeRegisters(address: number, values: number[], slaveId = 1): Promise<void> {
    try {
      const res = await (await this.getClient(slaveId)).writeMultipleRegisters(address, values)
      toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async getRawSocket(slaveId = 1): Promise<net.Socket> {
    await this.getClient(slaveId)
    return this.clients.get(slaveId)!.socket
  }
}

/** RTU 串口驱动：一条串口一个 SerialPort，按 slave id 各建一个 ModbusRTUClient（共享同一 socket）。 */
export class SerialDriver implements ModbusDriver {
  private serialPort: any = null
  private ready = false
  private readonly clients = new Map<number, ModbusRTUClient>()

  constructor(private readonly config: Config, private readonly portCtor: any = SerialPort) {}

  async connect(opts: ConnectOptions): Promise<void> {
    this.disconnect()
    const path = opts.serialPath
    if (!path) throw new Error('serialPath is required for RTU')
    const flow = (opts.flowControl ?? 'none') === 'rtscts'
      ? { rtscts: true, xon: false, xoff: false }
      : (opts.flowControl ?? 'none') === 'xonxoff'
        ? { rtscts: false, xon: true, xoff: true }
        : { rtscts: false, xon: false, xoff: false }
    this.serialPort = await new Promise<any>((resolve, reject) => {
      const sp = new this.portCtor({
        path,
        baudRate: opts.baudRate ?? 9600,
        parity: (opts.parity ?? 'even') as any,
        stopBits: (opts.stopBits ?? 1) as 1 | 2,
        dataBits: (opts.dataBits ?? 8) as 8,
        rtscts: flow.rtscts,
        xon: flow.xon,
        xoff: flow.xoff,
        autoOpen: true,
      }, (err) => { if (err) reject(err); else resolve(sp) })
      // 打开后串口若有运行时错误（如被拔出），避免未处理 error 事件崩进程
      sp.on('error', () => {})
    })
    this.ready = true
  }

  disconnect(): void {
    this.ready = false
    this.clients.clear()
    if (this.serialPort) {
      try { this.serialPort.close() } catch { /* ignore */ }
      this.serialPort = null
    }
  }

  isConnected(): boolean { return this.ready }

  private getClient(slaveId: number): ModbusRTUClient {
    const existing = this.clients.get(slaveId)
    if (existing) return existing
    if (!this.serialPort) throw new Error('serial port not connected')
    const client = new ModbusRTUClient(this.serialPort as any, slaveId, this.config.defaultTimeoutMs)
    this.clients.set(slaveId, client)
    return client
  }

  async readHoldingRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await this.getClient(slaveId).readHoldingRegisters(address, count)
      return toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async readInputRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await this.getClient(slaveId).readInputRegisters(address, count)
      return toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async writeRegister(address: number, value: number, slaveId = 1): Promise<void> {
    try {
      const res = await this.getClient(slaveId).writeSingleRegister(address, value)
      toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async writeRegisters(address: number, values: number[], slaveId = 1): Promise<void> {
    try {
      const res = await this.getClient(slaveId).writeMultipleRegisters(address, values)
      toValues(res.response.body)
    } catch (e) { throw normalizeError(e) }
  }

  async getRawSocket(_slaveId = 1): Promise<any> {
    if (!this.serialPort) throw new Error('serial port not connected')
    return this.serialPort
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('modbus', {
    createDriver(transport = 'tcp'): ModbusDriver { return transport === 'rtu' ? new SerialDriver(config) : new JsmodbusDriver(config) },
  })
}
