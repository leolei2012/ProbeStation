export interface SerialPortOption { path: string; manufacturer?: string; description?: string }
export interface SerialPortList { ports: SerialPortOption[]; source: 'system' | 'mock'; location: 'backend'; enumerationOnly: true }
export interface SerialPortState { status: 'idle' | 'loading' | 'ready' | 'error'; ports: SerialPortOption[]; source: 'system' | 'mock' | null; error: string | null }
export const initialSerialPortState = (): SerialPortState => ({ status: 'idle', ports: [], source: null, error: null })

export function serialPortChoices(ports: SerialPortOption[], current: string) {
  const choices = ports.map(p => ({ value: p.path, label: [p.path, p.description, p.manufacturer].filter(Boolean).join(' · '), discovered: true }))
  if (current && !ports.some(p => p.path === current)) choices.unshift({ value: current, label: current, discovered: false })
  return choices
}

/** Request ordering/unmount guard. The typed/selected path is owned separately by the form. */
export class SerialPortLoader {
  private sequence = 0
  private controller?: AbortController
  state = initialSerialPortState()
  constructor(private readonly changed: (state: SerialPortState) => void) {}
  cancel() { this.sequence++; this.controller?.abort() }
  async refresh(fetcher: (signal: AbortSignal) => Promise<SerialPortList>) {
    this.controller?.abort()
    const sequence = ++this.sequence, controller = this.controller = new AbortController()
    this.state = { ...this.state, status: 'loading', error: null }; this.changed(this.state)
    try {
      const result = await fetcher(controller.signal)
      if (controller.signal.aborted || sequence !== this.sequence) return
      if (!Array.isArray(result.ports) || !['system', 'mock'].includes(result.source) || result.location !== 'backend' || result.enumerationOnly !== true || result.ports.some(p => typeof p.path !== 'string' || !p.path)) throw new Error('Invalid serial port response')
      this.state = { status: 'ready', ports: result.ports, source: result.source, error: null }
    } catch {
      if (controller.signal.aborted || sequence !== this.sequence) return
      this.state = { ...this.state, status: 'error', error: 'enumeration-failed' }
    }
    this.changed(this.state)
  }
}
