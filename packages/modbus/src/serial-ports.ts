import { SerialPort } from 'serialport'

export interface SerialPortMetadata { path: string; manufacturer?: string; description?: string }

/** Enumeration only: never constructs SerialPort, calls open(), probes or handshakes. */
export async function listSystemSerialPorts(): Promise<SerialPortMetadata[]> {
  return sanitizeSerialPorts(await SerialPort.list())
}

/** Return only identification text needed by the picker, never serial numbers or PNP IDs. */
export function sanitizeSerialPorts(ports: Array<{ path: string; manufacturer?: string; friendlyName?: string; description?: string }>): SerialPortMetadata[] {
  const result = new Map<string, SerialPortMetadata>()
  for (const port of ports) {
    if (typeof port.path !== 'string' || !port.path.trim()) continue
    const previous = result.get(port.path)
    result.set(port.path, {
      path: port.path,
      ...(previous ?? {}),
      ...(typeof port.manufacturer === 'string' && port.manufacturer ? { manufacturer: port.manufacturer } : {}),
      ...(typeof (port.description ?? port.friendlyName) === 'string' && (port.description ?? port.friendlyName) ? { description: port.description ?? port.friendlyName } : {}),
    })
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
}
