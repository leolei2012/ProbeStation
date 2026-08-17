import { randomUUID } from 'node:crypto'

/** 一条采样（原始 16 位字 + 时间戳 + 质量）。 */
export interface RecordingSample {
  ts: string
  address: number
  rawValue: number
  quality: string
}

/** 触发条件。 */
export interface RecordingTrigger {
  address: number
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'changed'
  threshold: number
  beforeMs: number
  afterMs: number
}

/** 一段录制会话（连续采样或触发记录）。 */
export interface RecordingSession {
  id: string
  deviceId: number
  mode: 'continuous' | 'trigger'
  intervalMs: number
  addresses: number[] | null
  originalPollInterval: number
  status: 'recording' | 'done'
  startedAt: number
  finishedAt: number | null
  samples: RecordingSample[]
  trigger: RecordingTrigger | null
  triggered: boolean
  lastTriggerValue: number | null
}

/**
 * 连续采样 + 触发记录引擎。
 * 原理：录制时临时把设备采样周期（monitor_objects.poll_interval_ms，PRD 08）调到 intervalMs，
 * 让 poller 以该速率轮询，本引擎订阅 poller/result 事件把采样攒进缓冲；结束后恢复原速率。
 * - 连续模式：记录 durationMs 后结束。
 * - 触发模式：维护 beforeMs 的环形窗口，条件命中后继续录 afterMs 再结束（带 10 分钟安全上限）。
 */
export class Recorder {
  private static readonly MAX_SESSIONS = 50 // 长期运行防内存无限增长：只保留最近 50 段录制
  private sessions = new Map<string, RecordingSession>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly ctx: any, private readonly cfg: any) {
    ctx.on('poller/result', ({ objectId, points }: any) => this.onResult(objectId, points))
  }

  private addSession(session: RecordingSession): void {
    this.sessions.set(session.id, session)
    while (this.sessions.size > Recorder.MAX_SESSIONS) {
      let oldestId: string | null = null
      let oldestTs = Infinity
      for (const s of this.sessions.values()) {
        if (s.startedAt < oldestTs) { oldestTs = s.startedAt; oldestId = s.id }
      }
      if (oldestId != null) this.sessions.delete(oldestId)
      else break
    }
  }

  /** 删除一段录制（含仍在录制中的，会先结束）。 */
  deleteRecording(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.finish(id)
    this.sessions.delete(id)
    return true
  }

  /** 连续采样：以 intervalMs 间隔录 durationMs 秒（毫秒）。addresses 缺省 = 全部。 */
  startRecording(deviceId: number, intervalMs: number, durationMs: number, addresses?: number[]): string {
    const obj = this.cfg.getObject(deviceId)
    if (!obj) throw new Error('device ' + deviceId + ' not found')
    const session: RecordingSession = {
      id: randomUUID(),
      deviceId,
      mode: 'continuous',
      intervalMs,
      addresses: addresses && addresses.length > 0 ? addresses : null,
      originalPollInterval: obj.pollIntervalMs ?? 1000,
      status: 'recording',
      startedAt: Date.now(),
      finishedAt: null,
      samples: [],
      trigger: null,
      triggered: false,
      lastTriggerValue: null,
    }
    this.addSession(session)
    this.cfg.updateObject(deviceId, { pollIntervalMs: intervalMs })
    this.timers.set(session.id, setTimeout(() => this.finish(session.id), durationMs))
    return session.id
  }

  /** 触发记录：trigger_address 满足 operator/阈值时，缓存触发前 beforeMs + 触发后 afterMs。 */
  startTriggerRecording(deviceId: number, intervalMs: number, triggerAddress: number, operator: string, threshold: number, beforeMs: number, afterMs: number, addresses?: number[]): string {
    const obj = this.cfg.getObject(deviceId)
    if (!obj) throw new Error('device ' + deviceId + ' not found')
    const session: RecordingSession = {
      id: randomUUID(),
      deviceId,
      mode: 'trigger',
      intervalMs,
      addresses: addresses && addresses.length > 0 ? addresses : null,
      originalPollInterval: obj.pollIntervalMs ?? 1000,
      status: 'recording',
      startedAt: Date.now(),
      finishedAt: null,
      samples: [],
      trigger: { address: triggerAddress, operator: operator as RecordingTrigger['operator'], threshold, beforeMs, afterMs },
      triggered: false,
      lastTriggerValue: null,
    }
    this.addSession(session)
    this.cfg.updateObject(deviceId, { pollIntervalMs: intervalMs })
    // 安全上限：10 分钟仍不触发则结束，避免无限录制
    this.timers.set(session.id, setTimeout(() => this.finish(session.id), 10 * 60 * 1000))
    return session.id
  }

  getRecording(id: string): RecordingSession | null {
    return this.sessions.get(id) ?? null
  }

  listRecordings(): Array<{ id: string; deviceId: number; mode: string; status: string; sampleCount: number; triggered: boolean; startedAt: number; finishedAt: number | null }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, deviceId: s.deviceId, mode: s.mode, status: s.status,
      sampleCount: s.samples.length, triggered: s.triggered, startedAt: s.startedAt, finishedAt: s.finishedAt,
    }))
  }

  stopRecording(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.finish(id)
    return true
  }

  private onResult(objectId: number, points: Array<{ objectId: number; address: number; timestamp: string; rawValue: number; quality: string }>): void {
    for (const s of this.sessions.values()) {
      if (s.status !== 'recording' || s.deviceId !== objectId) continue
      const filtered = s.addresses ? points.filter((p) => s.addresses!.includes(p.address)) : points
      if (filtered.length === 0) continue
      for (const p of filtered) s.samples.push({ ts: p.timestamp, address: p.address, rawValue: p.rawValue, quality: p.quality })
      if (s.mode === 'trigger' && !s.triggered) {
        // 保持 before 窗口有界
        const cutoff = Date.now() - s.trigger!.beforeMs
        s.samples = s.samples.filter((sm) => new Date(sm.ts).getTime() >= cutoff)
        this.maybeTrigger(s, filtered)
      }
    }
  }

  private maybeTrigger(s: RecordingSession, points: Array<{ address: number; rawValue: number }>): void {
    const p = points.find((p) => p.address === s.trigger!.address)
    if (!p) return
    const v = p.rawValue
    let hit = false
    switch (s.trigger!.operator) {
      case '>': hit = v > s.trigger!.threshold; break
      case '<': hit = v < s.trigger!.threshold; break
      case '>=': hit = v >= s.trigger!.threshold; break
      case '<=': hit = v <= s.trigger!.threshold; break
      case '==': hit = v === s.trigger!.threshold; break
      case '!=': hit = v !== s.trigger!.threshold; break
      case 'changed': hit = s.lastTriggerValue !== null && v !== s.lastTriggerValue; break
    }
    s.lastTriggerValue = v
    if (!hit) return
    s.triggered = true
    const old = this.timers.get(s.id)
    if (old) clearTimeout(old)
    this.timers.set(s.id, setTimeout(() => this.finish(s.id), s.trigger!.afterMs))
  }

  private finish(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.status !== 'recording') return
    s.status = 'done'
    s.finishedAt = Date.now()
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    const obj = this.cfg.getObject(s.deviceId)
    if (obj) this.cfg.updateObject(s.deviceId, { pollIntervalMs: s.originalPollInterval })
  }
}
