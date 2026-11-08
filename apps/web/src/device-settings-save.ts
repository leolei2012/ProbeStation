import { captureDeviceEditBaseline, parseDeviceEditRequest, type DeviceEditBaseline, type DeviceEditChanges } from '../../../packages/core/src/device-settings-edit'

/** Exactly one guarded request; never fall back to legacy unconditional device PUT. */
export async function saveGuardedDeviceSettings(expected: DeviceEditBaseline, changes: DeviceEditChanges, put: (url: string, body: unknown) => Promise<unknown>): Promise<readonly string[]> {
  const request = parseDeviceEditRequest({ expected, changes })
  const uncertain = () => new Error('保存结果待核实，请核对设备配置，勿自动重复保存。')
  let response: any
  try { response = await put('/api/monitor_objects/' + expected.id + '/settings', request) }
  catch (error) {
    const state = error as { statusCode?: unknown; version?: unknown; code?: unknown; outcome?: unknown } | null
    if (error instanceof Error && state?.statusCode === 503 && state.version === 1 && state.code === 'CONFIG_WRITE_NOT_STARTED' && state.outcome === 'not-applied') throw new Error('本次保存未执行，配置连接已隔离。草稿保留在当前窗口；请管理员核查并恢复后再核对配置，勿直接重复保存。之前请求结果仍须单独核实。')
    if (error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) throw error
    throw uncertain()
  }
  if (!response || !Array.isArray(response.warnings) || response.warnings.some((v: unknown) => typeof v !== 'string')) throw uncertain()
  let saved
  try { saved = captureDeviceEditBaseline(response.device) } catch { throw uncertain() }
  if (saved.id !== expected.id || Object.entries(request.changes).some(([key, value]) => saved[key as keyof DeviceEditBaseline] !== value)) throw uncertain()
  return Object.freeze([...response.warnings])
}
