/** Modbus 标准数据区。 */
export type ModbusArea = 'coil' | 'discrete-input' | 'holding-register' | 'input-register'

/** ProbeStation 当前计划支持的标准功能码。 */
export type ModbusFunctionCode = 1 | 2 | 3 | 4 | 5 | 6 | 15 | 16

export const MODBUS_FUNCTION_CODES = [1, 2, 3, 4, 5, 6, 15, 16] as const

export type ModbusErrorCode =
  | 'invalid_request'
  | 'unsupported_function'
  | 'connection_error'
  | 'serial_open_error'
  | 'timeout'
  | 'no_response'
  | 'partial_response'
  | 'crc_mismatch'
  | 'transaction_mismatch'
  | 'slave_id_mismatch'
  | 'function_mismatch'
  | 'modbus_exception'
  | 'cancelled'
  | 'unknown'

export interface ModbusRequest {
  slaveId: number
  functionCode: ModbusFunctionCode
  startAddress: number
  /** 读操作的数量；写操作省略时从 values 推导。 */
  quantity?: number
  values?: ReadonlyArray<number | boolean>
}

export interface ModbusFailure {
  code: ModbusErrorCode
  message: string
  retryable: boolean
  exceptionCode?: number
}

export interface ModbusResult {
  ok: boolean
  request: ModbusRequest
  area: ModbusArea
  values?: Array<number | boolean>
  durationMs: number
  requestFrame?: Uint8Array
  responseFrame?: Uint8Array
  error?: ModbusFailure
}

export class ModbusRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModbusRequestError'
  }
}

export function isModbusFunctionCode(value: number): value is ModbusFunctionCode {
  return (MODBUS_FUNCTION_CODES as readonly number[]).includes(value)
}

export function isReadFunction(functionCode: ModbusFunctionCode): boolean {
  return functionCode >= 1 && functionCode <= 4
}

export function isWriteFunction(functionCode: ModbusFunctionCode): boolean {
  return !isReadFunction(functionCode)
}

export function areaForFunction(functionCode: ModbusFunctionCode): ModbusArea {
  switch (functionCode) {
    case 1: case 5: case 15: return 'coil'
    case 2: return 'discrete-input'
    case 3: case 6: case 16: return 'holding-register'
    case 4: return 'input-register'
  }
}

export function quantityForRequest(request: ModbusRequest): number {
  if (isReadFunction(request.functionCode)) return request.quantity ?? 0
  if (request.functionCode === 5 || request.functionCode === 6) return 1
  return request.values?.length ?? request.quantity ?? 0
}

/**
 * 按 Modbus Application Protocol 的常用 PDU 上限校验请求。
 * 地址统一使用协议地址 0..65535，不接受 40001 这类展示地址。
 */
export function validateModbusRequest(request: ModbusRequest): string[] {
  const errors: string[] = []
  const { slaveId, functionCode, startAddress, values } = request
  const quantity = quantityForRequest(request)

  if (!Number.isInteger(slaveId) || slaveId < 0 || slaveId > 247) errors.push('slaveId must be an integer between 0 and 247')
  if (!isModbusFunctionCode(functionCode)) errors.push('unsupported function code ' + String(functionCode))
  if (!Number.isInteger(startAddress) || startAddress < 0 || startAddress > 0xffff) errors.push('startAddress must be an integer between 0 and 65535')
  if (!Number.isInteger(quantity) || quantity < 1) errors.push('quantity must be a positive integer')
  if (slaveId === 0 && isReadFunction(functionCode)) errors.push('broadcast slaveId 0 is only valid for write operations')

  const max = functionCode === 1 || functionCode === 2 ? 2000
    : functionCode === 3 || functionCode === 4 ? 125
      : functionCode === 15 ? 1968
        : functionCode === 16 ? 123
          : 1
  if (quantity > max) errors.push(`quantity ${quantity} exceeds FC${functionCode} limit ${max}`)
  if (Number.isInteger(startAddress) && Number.isInteger(quantity) && startAddress + quantity > 0x10000) errors.push('address range exceeds 65535')

  if (isReadFunction(functionCode) && values != null) errors.push('read operations must not include values')
  if (isWriteFunction(functionCode) && (!values || values.length === 0)) errors.push('write operations require values')
  if ((functionCode === 5 || functionCode === 6) && values?.length !== 1) errors.push(`FC${functionCode} requires exactly one value`)
  if ((functionCode === 5 || functionCode === 15) && values?.some(value => typeof value !== 'boolean')) errors.push(`FC${functionCode} values must be boolean`)
  if ((functionCode === 6 || functionCode === 16) && values?.some(value => typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff)) {
    errors.push(`FC${functionCode} values must be uint16 integers`)
  }
  return errors
}

export function assertModbusRequest(request: ModbusRequest): void {
  const errors = validateModbusRequest(request)
  if (errors.length > 0) throw new ModbusRequestError(errors.join('; '))
}

export function classifyModbusError(error: unknown): ModbusFailure {
  const anyError = error as any
  const message = typeof anyError?.message === 'string' ? anyError.message
    : typeof anyError?.err === 'string' ? anyError.err
      : typeof error === 'string' ? error
        : 'Unknown Modbus error'
  const text = `${anyError?.err ?? ''} ${message}`.toLowerCase()
  const exceptionCode = anyError?.exceptionCode ?? anyError?.response?.body?.code

  if (error instanceof ModbusRequestError) return { code: 'invalid_request', message, retryable: false }
  if (exceptionCode != null || text.includes('modbusexception') || text.includes('modbus exception')) {
    return { code: 'modbus_exception', message, retryable: false, exceptionCode: Number(exceptionCode) }
  }
  if (text.includes('crc')) return { code: 'crc_mismatch', message, retryable: true }
  if (text.includes('partial') || text.includes('incomplete')) return { code: 'partial_response', message, retryable: true }
  if (text.includes('transaction') || text.includes('outofsync')) return { code: 'transaction_mismatch', message, retryable: true }
  if (text.includes('slave id') || text.includes('unit id')) return { code: 'slave_id_mismatch', message, retryable: true }
  if (text.includes('function mismatch')) return { code: 'function_mismatch', message, retryable: false }
  if (text.includes('timeout') || text.includes('timed out')) return { code: 'timeout', message, retryable: true }
  if (text.includes('cancel') || text.includes('abort')) return { code: 'cancelled', message, retryable: true }
  if (text.includes('serial') && (text.includes('open') || text.includes('setcommstate'))) return { code: 'serial_open_error', message, retryable: true }
  if (text.includes('connect') || text.includes('socket') || text.includes('offline') || text.includes('closed')) return { code: 'connection_error', message, retryable: true }
  return { code: 'unknown', message, retryable: true }
}
