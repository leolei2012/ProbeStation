import type { DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'

/** Raw opening inputs, including inactive transport fields. No trimming, parsing or configuration writes. */
export function deviceDraftFields(initial: DeviceEditBaseline | null) {
  return Object.freeze({
    name: initial?.name ?? '', mode: initial?.mode ?? 'master', transport: initial?.transport ?? 'tcp', ip: initial?.ip ?? '',
    port: initial ? String(initial.port) : '8899', serialPath: initial?.serialPath ?? '', baudRate: initial ? String(initial.baudRate ?? 9600) : '9600',
    parity: initial?.parity ?? 'even', stopBits: initial ? String(initial.stopBits ?? 1) : '1', flowControl: initial?.flowControl ?? 'none',
    slaveId: initial ? String(initial.slaveId ?? 1) : '1', pollInterval: initial ? String(initial.pollIntervalMs ?? 1000) : '1000',
    timeout: initial ? String(initial.timeoutMs ?? 3000) : '3000', dataBits: String(initial?.dataBits ?? 8),
  })
}
export type DeviceDraftFields = ReturnType<typeof deviceDraftFields>
export function deviceDraftChanged(opening: DeviceDraftFields, current: DeviceDraftFields): boolean {
  return (Object.keys(opening) as Array<keyof DeviceDraftFields>).some(key => opening[key] !== current[key])
}
