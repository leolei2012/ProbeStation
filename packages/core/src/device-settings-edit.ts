export interface DeviceEditBaseline {
  readonly id: number; readonly name: string; readonly mode: string; readonly ip: string; readonly port: number
  readonly transport: string; readonly serialPath: string | null; readonly baudRate: number; readonly parity: string
  readonly stopBits: number; readonly dataBits: number; readonly flowControl: string; readonly slaveId: number
  readonly pollIntervalMs: number; readonly timeoutMs: number
}
export type DeviceEditChanges = Partial<Omit<DeviceEditBaseline, 'id'>>
const textKeys = ['name', 'mode', 'ip', 'transport', 'parity', 'flowControl'] as const
const numberKeys = ['port', 'baudRate', 'stopBits', 'dataBits', 'slaveId', 'pollIntervalMs', 'timeoutMs'] as const
export const deviceEditKeys = Object.freeze([...textKeys, ...numberKeys, 'serialPath'] as const)
const invalid = (): never => { throw Object.assign(new Error('设备编辑参数无效，请核对配置与输入。'), { statusCode: 400 }) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
/** Copy only reviewed editor fields; omit live connection status, activation and retention settings. */
export function captureDeviceEditBaseline(value: unknown): DeviceEditBaseline {
  const source = object(value)
  if (typeof source.id !== 'number' || !Number.isSafeInteger(source.id) || source.id < 1 || textKeys.some(key => typeof source[key] !== 'string') || numberKeys.some(key => typeof source[key] !== 'number' || !Number.isFinite(source[key])) || source.serialPath !== null && typeof source.serialPath !== 'string') return invalid()
  const copy: Record<string, unknown> = { id: source.id }
  for (const key of deviceEditKeys) copy[key] = source[key]
  return Object.freeze(copy) as unknown as DeviceEditBaseline
}
export function parseDeviceEditRequest(value: unknown): { expected: DeviceEditBaseline; changes: DeviceEditChanges } {
  const body = object(value), raw = object(body.changes), expected = captureDeviceEditBaseline(body.expected)
  if (Object.keys(body).some(key => !['expected', 'changes'].includes(key)) || !Object.keys(raw).length || Object.keys(raw).some(key => !(deviceEditKeys as readonly string[]).includes(key))) return invalid()
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) changed[key] = raw[key]
  const next = captureDeviceEditBaseline({ ...expected, ...changed })
  const integer = (n: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max
  if (!next.name.trim() || !['master', 'slave'].includes(next.mode) || !['tcp', 'rtu'].includes(next.transport) || !integer(next.slaveId, next.mode === 'slave' ? 1 : 0, 247) || !integer(next.baudRate, 1) || ![5, 6, 7, 8].includes(next.dataBits) || ![1, 2].includes(next.stopBits) || !['none', 'even', 'odd'].includes(next.parity) || !['none', 'rtscts', 'xonxoff'].includes(next.flowControl) || !integer(next.pollIntervalMs, 1, 2147483647) || !integer(next.timeoutMs, 1, 2147483647)) return invalid()
  if (next.transport === 'tcp' ? !next.ip.trim() || !integer(next.port, 1, 65535) : !next.serialPath?.trim()) return invalid()
  return { expected, changes: Object.freeze(changed) as DeviceEditChanges }
}
/** Conservative whole-editor condition; activation/retention changes remain independent. */
export function deviceEditMatches(current: DeviceEditBaseline, expected: DeviceEditBaseline): boolean {
  return current.id === expected.id && deviceEditKeys.every(key => current[key] === expected[key])
}
