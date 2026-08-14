import type { Context } from 'cordis'
import z from 'schemastery'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'workspace'
export const inject = ['config', 'store', 'poller']

export interface Config { defaultWorkspace: string; registryPath: string }
export const Config: z<Config> = z.object({
  defaultWorkspace: z.string().default('data'),
  registryPath: z.string().default(''),
})

/** 一条工作区注册记录（对齐 DSH workspaceRecord：path 规范化、title=basename）。 */
export interface WorkspaceRecord { path: string; title: string; lastUsedAt: string }
export interface WorkspaceInfo { current: string; currentTitle: string; recent: WorkspaceRecord[] }
export interface BrowseResult { path: string; parent: string | null; dirs: string[] }

/** 兼容旧版 string[] 注册表 + 新 records 格式。 */
function loadRegistry(regPath: string): WorkspaceRecord[] {
  try {
    const raw = JSON.parse(readFileSync(regPath, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry: unknown) => {
      if (typeof entry === 'string') return [{ path: entry, title: basename(entry), lastUsedAt: '' }]
      const r = entry as WorkspaceRecord
      if (typeof r?.path !== 'string') return []
      return [{ path: r.path, title: r.title ?? basename(r.path), lastUsedAt: r.lastUsedAt ?? '' }]
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

  constructor(private readonly ctx: any, config: Config) {
    this.registryPath = config.registryPath || join(homedir(), '.probestation', 'workspaces.json')
    this.recent = loadRegistry(this.registryPath)
    const initial = this.recent.length > 0 ? this.recent[0].path : resolve(config.defaultWorkspace)
    mkdirSync(initial, { recursive: true })
    this.current = resolve(initial)
    this.addToRegistry(this.current)
  }

  getCurrent(): string { return this.current }

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
    const dir = resolve(path)
    mkdirSync(dir, { recursive: true })
    this.ctx.poller.stopAll()
    await this.ctx.store.reopen(join(dir, 'poll.duckdb'))
    this.ctx.config.reopen(join(dir, 'config.db'))
    this.current = dir
    this.addToRegistry(dir)
    this.ctx.emit('workspace/changed', { path: dir })
    this.ctx.poller.startAll()
  }

  private addToRegistry(path: string): void {
    const canonical = resolve(path)
    const rec: WorkspaceRecord = { path: canonical, title: basename(canonical), lastUsedAt: new Date().toISOString() }
    this.recent = [rec, ...this.recent.filter(r => r.path !== canonical)].slice(0, 20)
    saveRegistry(this.registryPath, this.recent)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('workspace', new Workspace(ctx, config))
}
