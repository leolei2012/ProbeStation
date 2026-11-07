import type { RecordingIntervalLease, RecordingSourceGuard } from '../../packages/config/src/recording-interval.ts'

/** Explicit metadata-only test port. Production uses ConfigStore's SQLite lock/version implementation; source ABA tests use the real store, not this value-only mock. */
export function withMockRecordingIntervals<T extends { getObject(id: number): any; updateObject(id: number, fields: Record<string, unknown>): unknown }>(cfg: T) {
  const leases = new WeakMap<RecordingIntervalLease, string>()
  const scope = Symbol()
  const sources = new WeakMap<RecordingSourceGuard, string>()
  const source = (id: number) => { const row = cfg.getObject(id); return JSON.stringify(['mode', 'transport', 'slaveId', ...(row?.transport === 'rtu' ? ['serialPath', 'baudRate', 'parity', 'stopBits', 'dataBits', 'flowControl'] : ['ip', 'port'])].map(key => row?.[key])) }
  const update = cfg.updateObject.bind(cfg)
  const fingerprint = (id: number) => JSON.stringify(cfg.getObject(id))
  return Object.assign(cfg, {
    getRecordingIntervalScope: () => scope,
    captureRecordingSource(id: number) { const guard = Object.freeze({ deviceId: id }); sources.set(guard, source(id)); return guard },
    recordingSourceMatches(guard: RecordingSourceGuard) { return sources.has(guard) && sources.get(guard) === source(guard.deviceId) },
    revokeRecordingInterval(lease: RecordingIntervalLease) { leases.delete(lease) },
    acquireRecordingInterval(id: number, intervalMs: number, expected?: RecordingSourceGuard) {
      if (expected && (!sources.has(expected) || sources.get(expected) !== source(id))) throw Object.assign(new Error('mock source conflict'), { statusCode: 409 })
      const lease = Object.freeze({ deviceId: id, intervalMs, originalPollInterval: cfg.getObject(id).pollIntervalMs })
      update(id, { pollIntervalMs: intervalMs }); leases.set(lease, fingerprint(id))
      return { lease, warnings: [] as string[] }
    },
    recordingIntervalLeaseValid(lease: RecordingIntervalLease) { return leases.has(lease) && leases.get(lease) === fingerprint(lease.deviceId) },
    restoreRecordingInterval(lease: RecordingIntervalLease) {
      const valid = leases.has(lease) && leases.get(lease) === fingerprint(lease.deviceId); leases.delete(lease)
      if (!valid) return { state: 'preserved' as const, warnings: ['mock conflict'] }
      update(lease.deviceId, { pollIntervalMs: lease.originalPollInterval }); return { state: 'restored' as const, warnings: [] as string[] }
    },
  })
}
