import type { Context } from 'cordis'
import z from 'schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'core'

/** Global config validated by schemastery before the plugin starts. */
export interface Config {
  host: string
  port: number
  dbPath: string
  dataRetainDays: number
  pollIntervalMs: number
}

export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number(),
  dbPath: z.string(),
  dataRetainDays: z.number(),
  pollIntervalMs: z.number(),
})

export * from './codec.ts'
export * from './protocol.ts'
export * from './points.ts'
export * from './paths.ts'

export function apply(ctx: Context, config: Config): void {
  ctx.logger('core').info(
    `ProbeStation core loaded: ${config.host}:${config.port} (db=${config.dbPath}, retain=${config.dataRetainDays}d, poll=${config.pollIntervalMs}ms)`,
  )
}
