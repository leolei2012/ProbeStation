import { classifyModbusError, type ModbusFailure } from '@probebench/core'

export type ModbusTransportKind = 'tcp' | 'rtu'
export type ModbusFrameDirection = 'tx' | 'rx'

export interface ModbusFrameRecord {
  id: number
  timestamp: string
  transport: ModbusTransportKind
  direction: ModbusFrameDirection
  hex: string
  byteLength: number
  slaveId?: number
  functionCode?: number
  isException: boolean
  exceptionCode?: number
  channelKey?: string
  deviceId?: number
}

export interface ModbusDiagnosticsSnapshot {
  scope: 'device' | 'channel'
  channelKey?: string
  deviceId?: number
  txFrames: number
  rxFrames: number
  successCount: number
  errorCount: number
  timeoutCount: number
  consecutiveErrors: number
  recentErrorRate: number
  lastResponseMs?: number
  averageResponseMs?: number
  maxResponseMs?: number
  lastSuccessTime?: string
  lastErrorTime?: string
  lastError?: ModbusFailure
  bufferedFrames: number
}

export interface DiagnosticsIdentity { deviceId?: number; channelKey?: string }

/** 有界的内存诊断器。只保留近期报文和近期请求结果，避免长期运行时内存持续增长。 */
export class ModbusDiagnostics {
  private frames: ModbusFrameRecord[] = []
  private recentResults: boolean[] = []
  private nextFrameId = 1
  private txFrames = 0
  private rxFrames = 0
  private successCount = 0
  private errorCount = 0
  private timeoutCount = 0
  private consecutiveErrors = 0
  private totalResponseMs = 0
  private lastResponseMs?: number
  private maxResponseMs?: number
  private lastSuccessTime?: string
  private lastErrorTime?: string
  private lastError?: ModbusFailure

  constructor(
    private readonly transport: ModbusTransportKind,
    private readonly maxFrames = 2000,
    private readonly identity: DiagnosticsIdentity = {},
  ) {}

  recordFrame(direction: ModbusFrameDirection, data: Uint8Array): void {
    if (!data.byteLength) return
    const bytes = Buffer.from(data)
    const tcp = this.transport === 'tcp'
    const slaveId = tcp ? bytes[6] : bytes[0]
    const rawFunction = tcp ? bytes[7] : bytes[1]
    const functionCode = rawFunction == null ? undefined : rawFunction & 0x7f
    const isException = rawFunction != null && (rawFunction & 0x80) !== 0
    const exceptionCode = isException ? (tcp ? bytes[8] : bytes[2]) : undefined
    this.frames.push({
      id: this.nextFrameId++, timestamp: new Date().toISOString(), transport: this.transport,
      direction, hex: bytes.toString('hex').toUpperCase(), byteLength: bytes.length,
      slaveId, functionCode, isException, exceptionCode,
      channelKey: this.identity.channelKey, deviceId: this.identity.deviceId,
    })
    if (this.frames.length > this.maxFrames) this.frames.splice(0, this.frames.length - this.maxFrames)
    if (direction === 'tx') this.txFrames++
    else this.rxFrames++
  }

  recordSuccess(durationMs: number): void {
    this.successCount++
    this.consecutiveErrors = 0
    this.lastSuccessTime = new Date().toISOString()
    this.recordDuration(durationMs)
    this.pushResult(true)
  }

  recordError(error: unknown, durationMs: number): void {
    const failure = classifyModbusError(error)
    this.errorCount++
    this.consecutiveErrors++
    if (failure.code === 'timeout') this.timeoutCount++
    this.lastError = failure
    this.lastErrorTime = new Date().toISOString()
    this.recordDuration(durationMs)
    this.pushResult(false)
  }

  getFrames(limit = 200): ModbusFrameRecord[] {
    const safeLimit = Math.max(0, Math.min(this.maxFrames, Math.trunc(limit)))
    if (safeLimit === 0) return []
    return this.frames.slice(-safeLimit).map(frame => ({ ...frame }))
  }

  snapshot(): ModbusDiagnosticsSnapshot {
    const recentErrors = this.recentResults.filter(ok => !ok).length
    const completed = this.successCount + this.errorCount
    return {
      scope: this.identity.deviceId == null ? 'channel' : 'device',
      channelKey: this.identity.channelKey, deviceId: this.identity.deviceId,
      txFrames: this.txFrames, rxFrames: this.rxFrames,
      successCount: this.successCount, errorCount: this.errorCount, timeoutCount: this.timeoutCount,
      consecutiveErrors: this.consecutiveErrors,
      recentErrorRate: this.recentResults.length ? recentErrors / this.recentResults.length : 0,
      lastResponseMs: this.lastResponseMs,
      averageResponseMs: completed ? Number((this.totalResponseMs / completed).toFixed(2)) : undefined,
      maxResponseMs: this.maxResponseMs,
      lastSuccessTime: this.lastSuccessTime, lastErrorTime: this.lastErrorTime,
      lastError: this.lastError ? { ...this.lastError } : undefined,
      bufferedFrames: this.frames.length,
    }
  }

  clear(): void {
    this.frames = []
    this.recentResults = []
    this.txFrames = this.rxFrames = this.successCount = this.errorCount = this.timeoutCount = 0
    this.consecutiveErrors = this.totalResponseMs = 0
    this.lastResponseMs = this.maxResponseMs = undefined
    this.lastSuccessTime = this.lastErrorTime = undefined
    this.lastError = undefined
  }

  private recordDuration(durationMs: number): void {
    const duration = Math.max(0, durationMs)
    this.lastResponseMs = duration
    this.totalResponseMs += duration
    this.maxResponseMs = Math.max(this.maxResponseMs ?? 0, duration)
  }

  private pushResult(ok: boolean): void {
    this.recentResults.push(ok)
    if (this.recentResults.length > 100) this.recentResults.shift()
  }
}

/** 旁路监听 stream，不消费数据；write 包装保持原 this、参数和返回值。 */
export function attachFrameCapture(stream: any, diagnostics: ModbusDiagnostics): void {
  const marker = Symbol.for('probebench.modbus.frameCapture')
  if (stream[marker]) return
  stream[marker] = true
  const originalWrite = stream.write
  if (typeof originalWrite === 'function') {
    stream.write = function (...args: any[]) {
      const data = args[0]
      if (Buffer.isBuffer(data) || data instanceof Uint8Array) diagnostics.recordFrame('tx', data)
      return originalWrite.apply(this, args)
    }
  }
  stream.on('data', (data: unknown) => {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) diagnostics.recordFrame('rx', data)
  })
}
