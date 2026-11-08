import { captureDeviceEditBaseline, parseDeviceEditRequest, type DeviceEditBaseline, type DeviceEditChanges } from '../../../packages/core/src/device-settings-edit'
import { configurationWriteBlocked } from './configuration-write-outcome'

/** Exactly one guarded request; never fall back to legacy unconditional device PUT. */
export async function saveGuardedDeviceSettings(expected: DeviceEditBaseline, changes: DeviceEditChanges, put: (url: string, body: unknown) => Promise<unknown>): Promise<readonly string[]> {
  const request = parseDeviceEditRequest({ expected, changes })
  const uncertain = () => new Error('保存结果待核实，请核对设备配置，勿自动重复保存。')
  let response: any
  try { response = await put('/api/monitor_objects/' + expected.id + '/settings', request) }
  catch (error) {
    const blocked = configurationWriteBlocked(error)
    if (blocked) throw blocked
    if (error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) throw error
    throw uncertain()
  }
  if (!response || !Array.isArray(response.warnings) || response.warnings.some((v: unknown) => typeof v !== 'string')) throw uncertain()
  let saved
  try { saved = captureDeviceEditBaseline(response.device) } catch { throw uncertain() }
  if (saved.id !== expected.id || Object.entries(request.changes).some(([key, value]) => saved[key as keyof DeviceEditBaseline] !== value)) throw uncertain()
  return Object.freeze([...response.warnings])
}
