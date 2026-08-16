import type { Context } from 'cordis'
import z from 'schemastery'
import { OtaEngine } from './engine.ts'

export const name = 'ota'
export const inject = ['config', 'poller', 'workspace']

export interface Config {}
export const Config: z<Config> = z.object({})

/** OTA 固件升级引擎：0x41 状态机 + 固件上传/存储 + 断点续传。 */
export function apply(ctx: Context, _config: Config): void {
  ctx.provide('ota', new OtaEngine(ctx))
}
