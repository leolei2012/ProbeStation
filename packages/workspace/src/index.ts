import type { Context } from 'cordis'
import z from 'schemastery'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ConfigStore, HistoryExportConfigurationSnapshot } from '../../config/src/index.ts'
import type { DuckDBStore, ExportReadHandle } from '../../store/src/index.ts'

export const name = 'workspace'
export const inject = ['config', 'store', 'poller']

export interface Config { defaultWorkspace: string; registryPath: string }
export const Config: z<Config> = z.object({
  defaultWorkspace: z.string().default('data'),
  registryPath: z.string().default(''),
})

/** 一条工作区注册记录（对齐 DSH workspaceRecord：path 规范化、title=basename）。 */
export interface WorkspaceRecord { path: string; title: string; lastUsedAt: string; createdAt: string }
export interface WorkspaceInfo { current: string; currentTitle: string; recent: WorkspaceRecord[] }
export interface BrowseResult { path: string; parent: string | null; dirs: string[] }
/** Optional in-process lifecycle pairing, not an export/content revision or a data snapshot. */
export interface HistoryExportPair {
  readonly version: 1
  readonly workspaceScope: string
  readonly configuration: HistoryExportConfigurationSnapshot
  readonly storeHandle: ExportReadHandle
}
interface ExportBinding { config: ConfigStore; store: DuckDBStore; configurationScope: string; storeHandle: ExportReadHandle }
export class WorkspaceExportPairError extends Error {
  readonly code = 'WORKSPACE_EXPORT_PAIR_INVALID'
  constructor() { super('工作区导出配对未就绪或已失效。'); this.name = 'WorkspaceExportPairError' }
}

/** 兼容旧版 string[] 注册表 + 新 records 格式。 */
function loadRegistry(regPath: string): WorkspaceRecord[] {
  try {
    const raw = JSON.parse(readFileSync(regPath, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry: unknown) => {
      if (typeof entry === 'string') return [{ path: entry, title: basename(entry), lastUsedAt: '', createdAt: '' }]
      const r = entry as WorkspaceRecord
      if (typeof r?.path !== 'string') return []
      return [{ path: r.path, title: r.title ?? basename(r.path), lastUsedAt: r.lastUsedAt ?? '', createdAt: r.createdAt ?? r.lastUsedAt ?? '' }]
    }).slice(0, 20)
  } catch { return [] }
}

/** 原子写注册表：先写临时文件再 rename，失败则直接写（不丢已有数据）。 */
function saveRegistry(regPath: string, records: WorkspaceRecord[]): void {
  try {
    mkdirSync(dirname(regPath), { recursive: true })
    const json = JSON.stringify(records, null, 2)
    const tmp = regPath + '.tmp'
    writeFileSync(tmp, json)
    try { renameSync(tmp, regPath) } catch { writeFileSync(regPath, json) }
  } catch { /* 注册表不可写时忽略，功能仍可用 */ }
}

/** 启动时的工作区：优先注册表最近一条，否则默认目录。 */
export function resolveInitialWorkspace(defaultWorkspace: string, registryPath?: string): string {
  const regPath = registryPath || join(homedir(), '.probestation', 'workspaces.json')
  const records = loadRegistry(regPath)
  return records.length > 0 ? records[0].path : resolve(defaultWorkspace)
}

class Workspace {
  private current: string
  private recent: WorkspaceRecord[]
  private readonly registryPath: string
  private exportSwitching = false
  private exportScope = randomUUID()
  private exportBinding: ExportBinding | null = null
  private exportPairs = new WeakMap<HistoryExportPair, ExportBinding>()

  constructor(private readonly ctx: any, config: Config) {
    this.registryPath = config.registryPath || join(homedir(), '.probestation', 'workspaces.json')
    this.recent = loadRegistry(this.registryPath)
    const initial = this.recent.length > 0 ? this.recent[0].path : resolve(config.defaultWorkspace)
    mkdirSync(initial, { recursive: true })
    this.current = resolve(initial)
    this.addToRegistry(this.current)
  }

  getCurrent(): string { return this.current }

  private revokeExportPairs(): void {
    this.exportScope = randomUUID(); this.exportBinding = null; this.exportPairs = new WeakMap()
  }
  private checkExportBinding(binding: ExportBinding): void {
    if (binding.config !== this.ctx.config || binding.store !== this.ctx.store || binding.configurationScope !== binding.config.getHistoryExportConfigurationScope()) throw new WorkspaceExportPairError()
    binding.store.validateExportReadHandle(binding.storeHandle)
  }
  private requireExportBinding(): ExportBinding {
    if (this.exportSwitching || !this.exportBinding) throw new WorkspaceExportPairError()
    try { this.checkExportBinding(this.exportBinding); return this.exportBinding }
    catch { this.revokeExportPairs(); throw new WorkspaceExportPairError() }
  }
  /** No startup inference: only a completed managed switch can enable this optional capability. */
  captureHistoryExportPair(objectId: number): HistoryExportPair {
    const binding = this.requireExportBinding()
    const configuration = binding.config.getHistoryExportConfiguration(objectId)
    if (this.requireExportBinding() !== binding || configuration.configurationScope !== binding.configurationScope) throw new WorkspaceExportPairError()
    const pair = Object.freeze({ version: 1 as const, workspaceScope: this.exportScope, configuration, storeHandle: binding.storeHandle })
    this.exportPairs.set(pair, binding); return pair
  }
  /** Call again after asynchronous reads/attachment generation; no automatic API/Sink integration. */
  validateHistoryExportPair(pair: unknown): void {
    const binding = pair && typeof pair === 'object' ? this.exportPairs.get(pair as HistoryExportPair) : undefined
    if (!binding || binding !== this.requireExportBinding()) throw new WorkspaceExportPairError()
  }
  private captureExportBinding(config: ConfigStore, store: DuckDBStore): ExportBinding | null {
    // Older custom providers keep switch behavior, but cannot claim this new capability.
    if (typeof config?.getHistoryExportConfigurationScope !== 'function' || typeof config?.getHistoryExportConfiguration !== 'function' || typeof store?.captureExportReadHandle !== 'function' || typeof store?.validateExportReadHandle !== 'function') return null
    try {
      const binding = { config, store, configurationScope: config.getHistoryExportConfigurationScope(), storeHandle: store.captureExportReadHandle() }
      this.checkExportBinding(binding); return binding
    } catch { return null }
  }
  private finishExportTransition(binding: ExportBinding | null): void {
    if (!binding) return
    try { this.checkExportBinding(binding); this.exportBinding = binding }
    catch { this.revokeExportPairs() }
  }

  list(): WorkspaceInfo {
    const cur = this.recent.find(r => r.path === this.current)
    return { current: this.current, currentTitle: cur?.title ?? basename(this.current), recent: this.recent }
  }

  browse(path: string): BrowseResult {
    const p = resolve(path || this.current)
    let dirs: string[] = []
    try {
      dirs = readdirSync(p, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort()
    } catch { /* 不可读目录 */ }
    const parent = dirname(p)
    return { path: p, parent: parent === p ? null : parent, dirs }
  }

  async switchTo(path: string): Promise<void> {
    if (this.exportSwitching) throw new Error('Workspace is already switching')
    this.exportSwitching = true; this.revokeExportPairs()
    try {
      const dir = resolve(path)
      mkdirSync(dir, { recursive: true })
      await this.ctx.poller.stopAll()
      const store = this.ctx.store
      await store.reopen(join(dir, 'poll.duckdb'))
      const config = this.ctx.config
      config.reopen(join(dir, 'config.db'))
      const binding = this.captureExportBinding(config, store)
      this.current = dir
      this.addToRegistry(dir)
      this.ctx.emit('workspace/changed', { path: dir })
      this.ctx.poller.startAll()
      this.finishExportTransition(binding)
    } catch (error) { this.revokeExportPairs(); throw error }
    finally { this.exportSwitching = false }
  }

  private addToRegistry(path: string): void {
    const canonical = resolve(path)
    const existing = this.recent.find(r => r.path === canonical)
    const rec: WorkspaceRecord = { path: canonical, title: basename(canonical), lastUsedAt: new Date().toISOString(), createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.recent = [rec, ...this.recent.filter(r => r.path !== canonical)].slice(0, 20)
    saveRegistry(this.registryPath, this.recent)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('workspace', new Workspace(ctx, config))
}
