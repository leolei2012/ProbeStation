import type { FastifyInstance } from 'fastify'
import type { DuckDBStore } from '../../store/src/index.ts'
import type { ConfigStore } from '../../config/src/index.ts'
import { parseSamplePersistence, type PersistencePhase, type PersistenceFailure } from '../../core/src/sample-persistence.ts'

type StorageState = { phase: PersistencePhase | 'unavailable' | 'unknown'; failure: PersistenceFailure | 'unavailable' | 'status-unverified' }
type ConfigurationState = { phase: 'ready' | 'quarantined' | 'unavailable' | 'unknown'; failure: null | 'connection-quarantined' | 'lifecycle-unavailable' | 'unavailable' | 'status-unverified' }

/** Legacy storage readiness plus a separate, explicitly bounded two-dependency probe. No SQL or recovery. */
export function registerReadiness(app: FastifyInstance, service: () => Pick<DuckDBStore, 'getSamplePersistenceStatus'> | null | undefined, configuration?: () => Pick<ConfigStore, 'getConfigurationReadinessStatus'> | null | undefined) {
  let closing = false
  app.addHook('preClose', async () => { closing = true })
  const readStorage = () => {
    let storage: StorageState = { phase: 'unavailable', failure: 'unavailable' }
    let ready = false
    try {
      const store = closing ? undefined : service(), raw: unknown = store?.getSamplePersistenceStatus()
      if (raw && typeof (raw as { then?: unknown }).then === 'function') {
        void Promise.resolve(raw).catch(() => {}) // Unsupported async metadata must not escape as an unhandled rejection.
        storage = { phase: 'unknown', failure: 'status-unverified' }
      } else {
        const state = store && parseSamplePersistence(raw, null)
        if (state?.available) { storage = { phase: state.phase, failure: state.failure }; ready = state.phase === 'ready' && state.failure === null }
      }
    } catch { storage = { phase: 'unknown', failure: 'status-unverified' } }
    return { ready, storage }
  }
  const readConfiguration = (): { ready: boolean; state: ConfigurationState } => {
    let state: ConfigurationState = { phase: 'unavailable', failure: 'unavailable' }, ready = false
    try {
      const config = closing ? undefined : configuration?.()
      if (!config) return { ready, state }
      const raw: unknown = config.getConfigurationReadinessStatus()
      if (raw && typeof (raw as { then?: unknown }).then === 'function') {
        void Promise.resolve(raw).catch(() => {})
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const row = raw as Record<string, unknown>
        if (row.version === 1) {
          if (row.phase === 'ready' && row.failure === null) return { ready: true, state: { phase: 'ready', failure: null } }
          if (row.phase === 'quarantined' && row.failure === 'connection-quarantined') return { ready, state: { phase: 'quarantined', failure: 'connection-quarantined' } }
          if (row.phase === 'unavailable' && row.failure === 'lifecycle-unavailable') return { ready, state: { phase: 'unavailable', failure: 'lifecycle-unavailable' } }
        }
      }
      state = { phase: 'unknown', failure: 'status-unverified' }
    } catch { state = { phase: 'unknown', failure: 'status-unverified' } }
    return { ready, state }
  }
  app.get('/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { ready, storage } = readStorage()
    return reply.code(ready ? 200 : 503).send({ version: 1, status: ready ? 'ready' : 'not-ready', scope: 'sample-storage', storage })
  })
  app.get('/ready/core', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { ready: storageReady, storage } = readStorage(), config = readConfiguration()
    const ready = !closing && storageReady && config.ready
    return reply.code(ready ? 200 : 503).send({ version: 1, status: ready ? 'ready' : 'not-ready', scope: 'configuration-and-sample-storage', storage, configuration: config.state })
  })
}
