import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { ModbusTCPClient, ModbusRTUClient } from 'jsmodbus'
import { SerialPort } from 'serialport'
import {
  areaForFunction,
  assertModbusRequest,
  classifyModbusError,
  isModbusFunctionCode,
  type ModbusRequest,
  type ModbusResult,
} from '@probebench/core'
import {
  ModbusDiagnostics,
  attachFrameCapture,
  type DiagnosticsIdentity,
  type ModbusDiagnosticsSnapshot,
  type ModbusFrameRecord,
} from './diagnostics.js'

export * from './diagnostics.js'

export const name = 'modbus'

export interface Config {
  defaultTimeoutMs: number
  defaultUnitId: number
  connectTimeoutMs: number
  frameBufferSize?: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(3000),
  defaultUnitId: z.number().default(1),
  connectTimeoutMs: z.number().default(5000), // CH340/CP2102 首次 open 可能较慢，放宽到 5s
  frameBufferSize: z.number().default(2000),
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
  disconnect(): Promise<void>
  isConnected(): boolean
  readCoils(address: number, count: number, slaveId?: number): Promise<boolean[]>
  readDiscreteInputs(address: number, count: number, slaveId?: number): Promise<boolean[]>
  readHoldingRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  readInputRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  writeRegister(address: number, value: number, slaveId?: number): Promise<void>
  writeRegisters(address: number, values: number[], slaveId?: number): Promise<void>
  writeCoil(address: number, value: boolean, slaveId?: number): Promise<void>
  writeCoils(address: number, values: boolean[], slaveId?: number): Promise<void>
  /** 统一请求入口；兼容阶段先覆盖现有 FC03/04/06/16，其他功能码按后续阶段逐项实现。 */
  execute(request: ModbusRequest): Promise<ModbusResult>
  /** 返回底层原始 socket（net.Socket / SerialPort），供 OTA 拼 0x41 原始帧直连。 */
  getRawSocket(slaveId?: number): Promise<any>
  getDiagnostics(): ModbusDiagnosticsSnapshot
  getFrames(limit?: number): ModbusFrameRecord[]
  clearDiagnostics(): void
}

/**
 * 在不破坏旧驱动方法的前提下提供统一执行入口。
 * 后续 FC01/02/05/15 落地时只需扩展这里和具体 transport，不需要改变 poller 的结果契约。
 */
export async function executeModbusRequest(driver: ModbusDriver, request: ModbusRequest): Promise<ModbusResult> {
  const started = Date.now()
  const area = isModbusFunctionCode(Number(request.functionCode)) ? areaForFunction(request.functionCode) : 'holding-register'
  try {
    assertModbusRequest(request)
    const slaveId = request.slaveId
    let values: Array<number | boolean> | undefined
    switch (request.functionCode) {
      case 1:
        values = await driver.readCoils(request.startAddress, request.quantity!, slaveId)
        break
      case 2:
        values = await driver.readDiscreteInputs(request.startAddress, request.quantity!, slaveId)
        break
      case 3:
        values = await driver.readHoldingRegisters(request.startAddress, request.quantity!, slaveId)
        break
      case 4:
        values = await driver.readInputRegisters(request.startAddress, request.quantity!, slaveId)
        break
      case 6:
        await driver.writeRegister(request.startAddress, request.values![0] as number, slaveId)
        break
      case 16:
        await driver.writeRegisters(request.startAddress, Array.from(request.values as ReadonlyArray<number>), slaveId)
        break
      default:
        return {
          ok: false,
          request,
          area,
          durationMs: Date.now() - started,
          error: { code: 'unsupported_function', message: `FC${request.functionCode} is not implemented by this driver yet`, retryable: false },
        }
    }
    return { ok: true, request, area, values, durationMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      request,
      area,
      durationMs: Date.now() - started,
      error: classifyModbusError(error),
    }
  }
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
      const error = new Error(EXC_MSG[code] ?? 'Modbus exception')
      ;(error as any).exceptionCode = code
      return error
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

  private readonly diagnostics: ModbusDiagnostics

  constructor(private readonly config: Config, identity: DiagnosticsIdentity = {}) {
    this.diagnostics = new ModbusDiagnostics('tcp', config.frameBufferSize ?? 2000, identity)
  }

  async connect(opts: ConnectOptions): Promise<void> {
    this.host = opts.ip ?? ''
    this.port = opts.port ?? 502
    this.ready = true
  }

  async disconnect(): Promise<void> {
    for (const c of this.clients.values()) c.socket.destroy()
    this.clients.clear()
    this.ready = false
  }

  isConnected(): boolean {
    if (!this.ready) return false
    for (const { socket } of this.clients.values()) {
      if (!socket.destroyed && socket.writable) return true
    }
    return false
  }

  private async getClient(slaveId: number): Promise<ModbusTCPClient> {
    const existing = this.clients.get(slaveId)
    if (existing && !existing.socket.destroyed && existing.socket.writable) return existing.client
    const socket = new net.Socket()
    attachFrameCapture(socket, this.diagnostics)
    const client = new ModbusTCPClient(socket, slaveId, this.config.defaultTimeoutMs)
    const drop = () => {
      const cur = this.clients.get(slaveId)
      if (cur && cur.socket === socket) this.clients.delete(slaveId)
    }
    socket.on('close', drop)
    socket.on('error', drop)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.connect(this.port, this.host)
    })
    this.clients.set(slaveId, { socket, client })
    return client
  }

  async readCoils(address: number, count: number, slaveId = 1): Promise<boolean[]> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).readCoils(address, count)
      const values = toBits(res.response.body).slice(0, count); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readDiscreteInputs(address: number, count: number, slaveId = 1): Promise<boolean[]> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).readDiscreteInputs(address, count)
      const values = toBits(res.response.body).slice(0, count); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readHoldingRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).readHoldingRegisters(address, count)
      const values = toValues(res.response.body); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readInputRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).readInputRegisters(address, count)
      const values = toValues(res.response.body); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeRegister(address: number, value: number, slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).writeSingleRegister(address, value)
      toValues(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeRegisters(address: number, values: number[], slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).writeMultipleRegisters(address, values)
      toValues(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeCoil(address: number, value: boolean, slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).writeSingleCoil(address, value)
      toBits(res.response.body) // FC05/FC15 响应无数据，仅校验异常
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeCoils(address: number, values: boolean[], slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await (await this.getClient(slaveId)).writeMultipleCoils(address, values)
      toBits(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  execute(request: ModbusRequest): Promise<ModbusResult> { return executeModbusRequest(this, request) }

  async getRawSocket(slaveId = 1): Promise<net.Socket> {
    await this.getClient(slaveId)
    return this.clients.get(slaveId)!.socket
  }
  getDiagnostics(): ModbusDiagnosticsSnapshot { return this.diagnostics.snapshot() }
  getFrames(limit?: number): ModbusFrameRecord[] { return this.diagnostics.getFrames(limit) }
  clearDiagnostics(): void { this.diagnostics.clear() }
}

/** 把 FC01/02 响应转换为稳定的布尔数组。 */
function toBits(body: any): boolean[] {
  if (body.isException) {
    const code = body.code ?? body.exceptionCode
    const error = new Error(EXC_MSG[code] ?? body.message ?? ('Modbus exception ' + code))
    ;(error as any).exceptionCode = code
    throw error
  }
  const arr = body.valuesAsArray as Array<boolean | number> | undefined
  return arr ? Array.from(arr, value => Boolean(value)) : []
}

/** RTU 串口驱动：一条串口一个 SerialPort，按 slave id 各建一个 ModbusRTUClient（共享同一 socket）。 */
export class SerialDriver implements ModbusDriver {
  private serialPort: any = null
  private ready = false
  private readonly clients = new Map<number, ModbusRTUClient>()
  private readonly diagnostics: ModbusDiagnostics

  constructor(
    private readonly config: Config,
    private readonly portCtor: any = SerialPort,
    private readonly onWarn: (msg: string) => void = (msg) => console.warn('[modbus]', msg),
    identity: DiagnosticsIdentity = {},
  ) { this.diagnostics = new ModbusDiagnostics('rtu', config.frameBufferSize ?? 2000, identity) }

  async connect(opts: ConnectOptions): Promise<void> {
    await this.disconnect()
    const path = opts.serialPath
    if (!path) throw new Error('serialPath is required for RTU')
    const flow = (opts.flowControl ?? 'none') === 'rtscts'
      ? { rtscts: true, xon: false, xoff: false }
      : (opts.flowControl ?? 'none') === 'xonxoff'
        ? { rtscts: false, xon: true, xoff: true }
        : { rtscts: false, xon: false, xoff: false }
    this.serialPort = await this.openPort({
      path,
      baudRate: opts.baudRate ?? 9600,
      parity: (opts.parity ?? 'even') as any,
      stopBits: (opts.stopBits ?? 1) as 1 | 2,
      dataBits: (opts.dataBits ?? 8) as 8,
      rtscts: flow.rtscts,
      xon: flow.xon,
      xoff: flow.xoff,
      autoOpen: true,
    }, this.config.connectTimeoutMs ?? this.config.defaultTimeoutMs)
    attachFrameCapture(this.serialPort, this.diagnostics)
    this.ready = true
  }

  /**
   * 打开串口并等待 open 回调，带超时兜底。
   * 症状背景：CH340/CP2102 等 USB 转串口驱动可能出现「原生已占用串口，但 binding.open 的
   * Promise 永不 settle」→ open 回调不来 → connect() 永久 pending → 轮询静默卡死。
   * 这里：1) 超时 reject；2) 失败/超时时尽力关闭半开句柄；3) 不吞 error（open 阶段 reject，运行期告警）。
   */
  private openPort(options: Record<string, any>, timeoutMs: number): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      let sp: any = null
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // 超时：open 回调始终没来。此刻 sp 可能还没 open，close() 对未 open 的端口是 no-op，尽力而为；
        // 若回调晚到会在下方二次 close。
        if (sp) { try { sp.close() } catch { /* ignore */ } }
        reject(new Error(`Serial port ${options.path} open timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      try {
        sp = new this.portCtor(options, (err: any) => {
          clearTimeout(timer)
          if (settled) {
            // 超时之后回调才到：若此刻才打开成功，需关掉，避免句柄泄漏
            if (!err && sp) { try { sp.close() } catch { /* ignore */ } }
            return
          }
          settled = true
          if (err) reject(err)
          else resolve(sp)
        })
        // 打开成功后的运行期错误（如拔出）：标记断开 + 告警；读/写路径会各自再向上抛错
        sp.on('error', (err: any) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          } else {
            if (this.serialPort === sp) this.ready = false
            const msg = err && err.message ? err.message : String(err)
            this.onWarn('serial port runtime error: ' + msg)
          }
        })
        // 串口被关闭/拔出：若仍是当前端口则标记断开，让 poller 下次重建连接
        sp.on('close', () => { if (this.serialPort === sp) this.ready = false })
      } catch (e) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(e)
        }
      }
    })
  }

  async disconnect(): Promise<void> {
    this.ready = false
    this.clients.clear()
    const sp = this.serialPort
    this.serialPort = null
    if (sp) await this.closePort(sp)
  }

  /** 等待串口真正关闭：serialport 的 close() 本身不返回 Promise（回调/事件式），这里用回调包一层并加超时兜底。 */
  private closePort(sp: any): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      try { sp.close(finish) } catch { finish() }
      const t = setTimeout(finish, 2000)
      if (typeof t.unref === 'function') t.unref()
    })
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

  async readCoils(address: number, count: number, slaveId = 1): Promise<boolean[]> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).readCoils(address, count)
      const values = toBits(res.response.body).slice(0, count); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readDiscreteInputs(address: number, count: number, slaveId = 1): Promise<boolean[]> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).readDiscreteInputs(address, count)
      const values = toBits(res.response.body).slice(0, count); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readHoldingRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).readHoldingRegisters(address, count)
      const values = toValues(res.response.body); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async readInputRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).readInputRegisters(address, count)
      const values = toValues(res.response.body); this.diagnostics.recordSuccess(Date.now() - started); return values
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeRegister(address: number, value: number, slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).writeSingleRegister(address, value)
      toValues(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeRegisters(address: number, values: number[], slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).writeMultipleRegisters(address, values)
      toValues(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeCoil(address: number, value: boolean, slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).writeSingleCoil(address, value)
      toBits(res.response.body) // FC05/FC15 响应无数据，仅校验异常
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  async writeCoils(address: number, values: boolean[], slaveId = 1): Promise<void> {
    const started = Date.now()
    try {
      const res = await this.getClient(slaveId).writeMultipleCoils(address, values)
      toBits(res.response.body)
      this.diagnostics.recordSuccess(Date.now() - started)
    } catch (e) { const error = normalizeError(e); this.diagnostics.recordError(error, Date.now() - started); throw error }
  }

  execute(request: ModbusRequest): Promise<ModbusResult> { return executeModbusRequest(this, request) }

  async getRawSocket(_slaveId = 1): Promise<any> {
    if (!this.serialPort) throw new Error('serial port not connected')
    return this.serialPort
  }
  getDiagnostics(): ModbusDiagnosticsSnapshot { return this.diagnostics.snapshot() }
  getFrames(limit?: number): ModbusFrameRecord[] { return this.diagnostics.getFrames(limit) }
  clearDiagnostics(): void { this.diagnostics.clear() }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('modbus', {
    createDriver(transport = 'tcp', identity: DiagnosticsIdentity = {}): ModbusDriver {
      if (transport === 'rtu') {
        const logger = ctx.logger('modbus')
        return new SerialDriver(config, SerialPort, (msg) => logger.warn(msg), identity)
      }
      return new JsmodbusDriver(config, identity)
    },
  })
}
