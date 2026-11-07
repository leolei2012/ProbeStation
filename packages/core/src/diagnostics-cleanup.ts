export interface DiagnosticsCleanupTarget { objectId: number; deviceName: string; scope: 'device' | 'channel'; channelKey: string; targetKey: string; label: string }
export interface DiagnosticsCleanupPreview extends DiagnosticsCleanupTarget { version: 1; token: string; expiresAt: string; bufferedFrames: number; successCount: number; errorCount: number }
export interface DiagnosticsCleanupResult extends DiagnosticsCleanupTarget { ok: true; token: string; completedAt: string; clearedFrames: number; clearedRequests: number }
export const diagnosticToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const count = (value: any): number => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid diagnostic cleanup response'); return value }
export function diagnosticsCleanupTarget(device: { id: number; name: string; mode?: string; transport: string; ip?: string; port?: number; serialPath?: string | null; baudRate?: number | null; parity?: string | null; stopBits?: number | null; dataBits?: number | null; flowControl?: string | null }): DiagnosticsCleanupTarget {
  if (!Number.isSafeInteger(device.id) || device.id < 1 || typeof device.name !== 'string' || device.mode === 'slave' || !['tcp', 'rtu'].includes(device.transport)) throw new Error('Invalid diagnostic cleanup target')
  const serial = device.transport === 'rtu', path = device.serialPath
  if (serial ? typeof path !== 'string' || !path.trim() : typeof device.ip !== 'string' || !device.ip.trim() || !Number.isInteger(device.port) || device.port! < 1 || device.port! > 65535) throw new Error('Invalid diagnostic cleanup connection')
  const connection = serial ? ['RTU', path, device.baudRate ?? 9600, device.parity ?? 'even', device.stopBits ?? 1, device.dataBits ?? 8, device.flowControl ?? 'none'] : ['TCP', device.ip, device.port]
  if (serial && (!Number.isSafeInteger(connection[2]) || Number(connection[2]) < 1 || !['even', 'odd', 'none'].includes(String(connection[3])) || ![1, 2].includes(Number(connection[4])) || ![5, 6, 7, 8].includes(Number(connection[5])) || !['none', 'rtscts', 'xonxoff'].includes(String(connection[6])))) throw new Error('Invalid diagnostic cleanup serial settings')
  return Object.freeze({ objectId: device.id, deviceName: device.name, scope: serial ? 'channel' : 'device', channelKey: serial ? 'rtu:' + path : 'tcp:' + device.id, targetKey: JSON.stringify([device.id, device.name, device.mode ?? 'master', ...connection]), label: connection.join(' · ') })
}
function target(value: any): DiagnosticsCleanupTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value) || count(value.objectId) < 1 || !['device', 'channel'].includes(value.scope) || ['deviceName', 'channelKey', 'targetKey', 'label'].some(key => typeof value[key] !== 'string') || !value.channelKey || !value.targetKey) throw new Error('Invalid diagnostic cleanup target')
  return { objectId: value.objectId, deviceName: value.deviceName, scope: value.scope, channelKey: value.channelKey, targetKey: value.targetKey, label: value.label }
}
export function parseDiagnosticsCleanupPreview(value: any, objectId: number): DiagnosticsCleanupPreview {
  const scope = target(value)
  if (value.version !== 1 || scope.objectId !== objectId || !diagnosticToken(value.token) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Invalid diagnostic cleanup preview')
  return Object.freeze({ ...scope, version: 1, token: value.token, expiresAt: value.expiresAt, bufferedFrames: count(value.bufferedFrames), successCount: count(value.successCount), errorCount: count(value.errorCount) })
}
export function parseDiagnosticsCleanupResult(value: any, preview: DiagnosticsCleanupPreview): DiagnosticsCleanupResult {
  const scope = target(value)
  if (value.ok !== true || value.token !== preview.token || Object.keys(scope).some(key => scope[key as keyof typeof scope] !== preview[key as keyof typeof scope]) || typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) throw new Error('Unverified diagnostic cleanup result')
  return Object.freeze({ ...scope, ok: true, token: value.token, completedAt: value.completedAt, clearedFrames: count(value.clearedFrames), clearedRequests: count(value.clearedRequests) })
}
