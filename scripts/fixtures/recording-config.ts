import type { RecordingIntervalLease } from '../../packages/config/src/recording-interval.ts'

/** Explicit metadata-only test port. Production uses ConfigStore's SQLite lock/version implementation. */
export function withMockRecordingIntervals<T extends { getObject(id: number): any; updateObject(id: number, fields: Record<string, unknown>): unknown }>(cfg: T) {
  const leases = new WeakMap<RecordingIntervalLease, string>()
  const scope = Symbol()
  const update = cfg.updateObject.bind(cfg)
  const fingerprint = (id: number) => JSON.stringify(cfg.getObject(id))
  return Object.assign(cfg, {
    getRecordingIntervalScope: () => scope,
    acquireRecordingInterval(id: number, intervalMs: number) {
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
