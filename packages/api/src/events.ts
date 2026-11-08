import type { AcquisitionOrigin } from '../../core/src/acquisition-origin.ts'

/** Existing event envelopes used by the API relay, not runtime payload validation. */
export interface PollResultEvent { objectId: number; points: readonly unknown[]; readOrigin?: AcquisitionOrigin }
export interface RuleTriggerEvent {
  ruleId: number; objectId: number; registerId: number; value: number | string
  operator: string; threshold: number; message: string | null; timestamp?: string; slaveId?: number
}
declare module 'cordis' {
  interface Events {
    'poller/result'(payload: PollResultEvent): void
    'rule/trigger'(payload: RuleTriggerEvent): void
    'poller/group-error'(payload: { objectId: number; groupId: number; error: string }): void
    // The poller also publishes the historical group-only form on recovery.
    'poller/group-ok'(payload: { groupId: number; objectId?: number }): void
    'device/status'(payload: { objectId: number; connected: boolean; error?: string }): void
  }
}
