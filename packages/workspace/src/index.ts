import type { Context } from 'cordis'
import z from 'schemastery'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'workspace'
export const inject = ['config', 'store', 'poller']

export interface Config { defaultWorkspace: string; registryPath: string }
export const Config: z<Config> = z.object({
  defaultWorkspace: z.string().default('data'),
  registryPath: z.string().default(''),
})

export interface WorkspaceInfo { current: string; recent: string[] }
export interface BrowseResult { path: string; parent: string | null; dirs: string[] }

/**
 * 工作区（对齐 DSH）：一个文件夹 = 一个自包含工作区，内含 config.db + poll.duckdb。
 * 切换工作区 = 停轮询 → 重开 store/config → 广播 → 重启轮询。
 */
class Workspace {
  private current: string
  private recent: string[]
  private readonly registryPath: string

  constructor(private readonly ctx: any, config: Config) {
    this.registryPath = config.registryPath || join(homedir(), '.probestation', 'workspaces.json')
    this.current = resolve(config.defaultWorkspace)
    this.recent = this.loadRegistry()
    this.addToRegistry(this.current)
    mkdirSync(this.current, { recursive: true })
  }

  getCurrent(): string { return this.current }

  list(): WorkspaceInfo { return { current: this.current, recent: this.recent } }

  /** 列出某目录下的子目录（供前端文件夹浏览）。 */
  browse(path: string): BrowseResult {
    const p = resolve(path || this.current)
    let dirs: string[] = []
    try {
      dirs = readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    } catch { /* 不可读目录 */ }
    const parent = dirname(p)
    return { path: p, parent: parent === p ? null : parent, dirs }
  }

  /** 切换工作区：停轮询 → 重开 store/config → 广播 → 重启轮询。 */
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

  private loadRegistry(): string[] {
    try { return JSON.parse(readFileSync(this.registryPath, 'utf8')) as string[] } catch { return [] }
  }
  private saveRegistry(): void {
    try { mkdirSync(dirname(this.registryPath), { recursive: true }); writeFileSync(this.registryPath, JSON.stringify(this.recent, null, 2)) } catch { /* 忽略 */ }
  }
  private addToRegistry(path: string): void {
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 20)
    this.saveRegistry()
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('workspace', new Workspace(ctx, config))
}
