import { captureDeviceEditBaseline, parseDeviceEditRequest, type DeviceEditBaseline, type DeviceEditChanges } from '../../../packages/core/src/device-settings-edit'

/** Exactly one guarded request; never fall back to legacy unconditional device PUT. */
export async function saveGuardedDeviceSettings(expected: DeviceEditBaseline, changes: DeviceEditChanges, put: (url: string, body: unknown) => Promise<unknown>): Promise<readonly string[]> {
  const request = parseDeviceEditRequest({ expected, changes }), response = await put('/api/monitor_objects/' + expected.id + '/settings', request) as any
  const uncertain = () => new Error('保存结果待核实，请核对设备配置，勿自动重复保存。')
  if (!response || !Array.isArray(response.warnings) || response.warnings.some((v: unknown) => typeof v !== 'string')) throw uncertain()
  let saved
  try { saved = captureDeviceEditBaseline(response.device) } catch { throw uncertain() }
  if (saved.id !== expected.id || Object.entries(request.changes).some(([key, value]) => saved[key as keyof DeviceEditBaseline] !== value)) throw uncertain()
  return Object.freeze([...response.warnings])
}
