import type { Context } from 'cordis'
import z from 'schemastery'
import { OtaEngine } from './engine.ts'
import { registerResourceCleanup } from '../../core/src/resource-close.ts'

export const name = 'ota'
export const inject = ['config', 'poller']

export interface Config { dataDir: string }
export const Config: z<Config> = z.object({
  dataDir: z.string().default('data'),
})

/** OTA 固件升级引擎：0x41 状态机 + 固件上传/存储 + 断点续传。 */
export function apply(ctx: Context, config: Config): void {
  const engine = new OtaEngine(ctx, config.dataDir)
  registerResourceCleanup(ctx, [(ctx as any).config, (ctx as any).poller], () => engine.close())
  ctx.provide('ota', engine)
}
