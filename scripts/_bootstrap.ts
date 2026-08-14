import { Context } from 'cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import * as importerPlugin from '../packages/importer/src/index.ts'
import * as workspacePlugin from '../packages/workspace/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'
import * as rulePlugin from '../packages/rule/src/index.ts'
import * as slavePlugin from '../packages/slave/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

export interface BootOptions {
  api?: { host?: string; port?: number }
  slave?: number
  rule?: boolean
  mcp?: boolean
}

/** 在临时工作区目录里装配完整应用栈（含 workspace 插件），返回 ctx + 临时目录。 */
export async function boot(opts: BootOptions = {}): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'probestation-'))
  const ctx = new Context()
  await ctx.plugin(configPlugin, { dbPath: join(dir, 'config.db') })
  await ctx.plugin(storePlugin, { dbPath: join(dir, 'poll.duckdb'), flushIntervalMs: 5000, flushBatchSize: 100 })
  await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 2000, defaultUnitId: 1 })
  await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })
  await ctx.plugin(sinkPlugin)
  await ctx.plugin(importerPlugin)
  await ctx.plugin(workspacePlugin, { defaultWorkspace: dir, registryPath: join(dir, 'registry.json') })
  if (opts.rule) await ctx.plugin(rulePlugin)
  if (opts.slave != null) await ctx.plugin(slavePlugin, { port: opts.slave })
  if (opts.mcp) await ctx.plugin(mcpPlugin)
  if (opts.api) await ctx.plugin(apiPlugin, { host: opts.api.host ?? '127.0.0.1', port: opts.api.port ?? 8080 })
  await new Promise((r) => setTimeout(r, 300))
  return { ctx, dir }
}
