import { capturePointEditBaseline, pointEditMatches, type PointEditBaseline } from '../../../packages/core/src/point-settings-edit'
import { saveGuardedPointSettings } from './point-settings-save'
import { runRequestWithTimeout } from './request-timeout'

export type AliasEditState = Readonly<{ value: string; phase: 'clean' | 'dirty' | 'saving' | 'saved' | 'blocked' | 'loading'; message: string }>
/** One editor owns its original condition. Refreshes may detect conflicts, never replace a dirty draft. */
export class AliasEdit {
  private baseline: PointEditBaseline
  private latest: PointEditBaseline
  private state: AliasEditState
  private listeners = new Set<() => void>()
  constructor(expected: PointEditBaseline) { this.baseline = this.latest = expected; this.state = Object.freeze({ value: expected.point.alias ?? '', phase: 'clean', message: '' }) }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<AliasEditState>) { this.state = Object.freeze({ ...this.state, ...patch }); this.listeners.forEach(listener => listener()) }
  private matches(next: PointEditBaseline) { return pointEditMatches(next, this.baseline, { alias: this.state.value || null }) }
  observe(expected: PointEditBaseline) {
    this.latest = expected
    if (this.state.phase === 'loading' || this.state.phase === 'saving' || this.state.phase === 'blocked') return
    if (this.state.phase === 'clean' || this.state.phase === 'saved' && this.matches(expected)) {
      this.baseline = expected; this.set({ value: expected.point.alias ?? '', phase: 'clean' }); return
    }
    if (!this.matches(expected)) this.set({ phase: 'blocked', message: '配置已变化，草稿已保留；请记录修改后重新载入。' })
  }
  edit(value: string) {
    if (['loading', 'saving'].includes(this.state.phase)) return
    this.set({ value, ...(this.state.phase === 'blocked' ? {} : { phase: value === (this.baseline.point.alias ?? '') ? 'clean' : 'dirty', message: '' }) })
  }
  async save(put: (url: string, body: unknown, signal: AbortSignal) => Promise<unknown>, onSaved: () => void, timeoutMs = 15000) {
    if (this.state.phase !== 'dirty') return
    const expected = this.baseline, value = this.state.value, changes = { alias: value || null }
    this.set({ phase: 'saving', message: '正在保存…' })
    try {
      const warnings = await saveGuardedPointSettings(expected, changes, (url, body) => runRequestWithTimeout(signal => put(url, body, signal), new AbortController().signal, timeoutMs))
      // A refresh can arrive during the request. Accept only the old condition or the exact saved identity.
      const after = capturePointEditBaseline({ ...expected.point, ...changes }, expected.group, expected.device)
      const refreshed = pointEditMatches(this.latest, expected, changes) || pointEditMatches(this.latest, after, changes)
      this.baseline = after
      this.set({ phase: refreshed ? 'saved' : 'blocked', message: ['别名已保存。', ...warnings, ...(refreshed ? [] : ['期间配置又有变化，请重新载入核对。'])].join(' ') })
      try { onSaved() } catch { this.set({ message: this.state.message + ' 刷新未完成，请重新载入核对，勿重复保存。' }) }
    } catch (error: any) {
      const known = /^HTTP (400|403|404|409|413|415)\b/.test(error?.message ?? '')
      this.set({ phase: 'blocked', message: known ? error.message + '；草稿已保留，请记录后重新载入。' : '保存结果待核实，草稿已保留；请记录后重新载入核对，勿重复保存。' })
    }
  }
  async reload(get: (url: string, signal: AbortSignal) => Promise<unknown>, timeoutMs = 15000) {
    if (['loading', 'saving'].includes(this.state.phase)) return
    const id = this.baseline.point.id
    this.set({ phase: 'loading', message: '正在读取当前配置，成功后将放弃草稿…' })
    try {
      const result = await runRequestWithTimeout(signal => get('/api/registers/' + id + '/settings', signal), new AbortController().signal, timeoutMs) as any
      const expected = capturePointEditBaseline(result?.expected?.point, result?.expected?.group, result?.expected?.device)
      if (expected.point.id !== id) throw new Error('快照编号不一致')
      this.baseline = this.latest = expected
      this.set({ value: expected.point.alias ?? '', phase: 'clean', message: '已载入当前配置，原草稿已放弃。' })
    } catch { this.set({ phase: 'blocked', message: '重新载入失败，草稿已保留；可再次载入。' }) }
  }
}
