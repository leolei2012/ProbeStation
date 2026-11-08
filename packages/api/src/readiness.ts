import type { FastifyInstance } from 'fastify'
import type { DuckDBStore } from '../../store/src/index.ts'
import { parseSamplePersistence, type PersistencePhase, type PersistenceFailure } from '../../core/src/sample-persistence.ts'

/** Storage readiness, not liveness or device health. Observes metadata only; never probes by writing. */
export function registerReadiness(app: FastifyInstance, service: () => Pick<DuckDBStore, 'getSamplePersistenceStatus'> | null | undefined) {
  app.get('/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let storage: { phase: PersistencePhase | 'unavailable' | 'unknown'; failure: PersistenceFailure | 'unavailable' | 'status-unverified' } = { phase: 'unavailable', failure: 'unavailable' }
    let ready = false
    try {
      const store = service(), raw: unknown = store?.getSamplePersistenceStatus()
      if (raw && typeof (raw as { then?: unknown }).then === 'function') {
        void Promise.resolve(raw).catch(() => {}) // Unsupported async metadata must not escape as an unhandled rejection.
        storage = { phase: 'unknown', failure: 'status-unverified' }
      } else {
        const state = store && parseSamplePersistence(raw, null)
        if (state?.available) { storage = { phase: state.phase, failure: state.failure }; ready = state.phase === 'ready' && state.failure === null }
      }
    } catch { storage = { phase: 'unknown', failure: 'status-unverified' } }
    return reply.code(ready ? 200 : 503).send({ version: 1, status: ready ? 'ready' : 'not-ready', scope: 'sample-storage', storage })
  })
}
