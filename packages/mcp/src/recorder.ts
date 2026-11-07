import { randomUUID } from 'node:crypto'
import { validSlaveId } from '../../core/src/sample-source.ts'
import { areaForFunction, type ModbusFunctionCode } from '../../core/src/protocol.ts'
import type { RecordingIntervalLease } from '../../config/src/recording-interval.ts'
import { parseRecordingIntervalStatus, type RecordingIntervalNotice, type RecordingIntervalStatus } from '../../core/src/recording-attention.ts'

export interface RecordingAddress { area: string; address: number; slaveId?: number }
type SourceAddress = RecordingAddress & { slaveId: number }
type InputSample = { objectId?: number; area: string; address: number; timestamp: string; rawValue: number; quality: string; slaveId?: number | null; batchId?: string | null }
const areas = ['coil', 'discrete-input', 'holding-register', 'input-register']
const operators = ['>', '<', '>=', '<=', '==', '!=', 'changed']
const MAX_TIMEOUT_MS = 2 ** 31 - 1
export const DEFAULT_RECORDING_SAMPLE_LIMITS = Object.freeze({ maxSamplesPerSession: 200000, maxTotalSamples: 500000 })
export const DEFAULT_RECORDING_PAGE_SIZE = 200
export const MAX_RECORDING_PAGE_SIZE = 1000
export type RecordingCompletionReason = 'duration' | 'trigger-window' | 'trigger-timeout' | 'stopped' | 'deleted' | 'sample-limit' | 'storage-limit' | 'configuration-changed'
export interface RecordingSampleLimits { maxSamplesPerSession: number; maxTotalSamples: number }

/** 一条采样（原始 16 位字 + 时间戳 + 质量）。 */
export interface RecordingSample {
  ts: string
  area: string
  address: number
  rawValue: number
  quality: string
  slaveId: number | null
  batchId: string | null
  /** Source metadata is present; not physical authentication or automatic PASS/FAIL. */
  sourceVerified: boolean
}

/** 触发条件。 */
export interface RecordingTrigger {
  slaveId: number
  area: string
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
  /** Default capture source; null records all sources when addresses is null. */
  slaveId: number | null
  addresses: SourceAddress[] | null
  originalPollInterval: number
  intervalRestore: 'pending' | 'shared' | 'restored' | 'preserved' | 'uncertain'
  warnings: string[]
  sampleLimit: number
  completionReason: RecordingCompletionReason | null
  quotaTruncated: boolean
  /** Only eligible samples rejected in the final received event; future unseen samples are not counted. */
  discardedSamples: number
  status: 'recording' | 'done'
  startedAt: number
  finishedAt: number | null
  samples: RecordingSample[]
  trigger: RecordingTrigger | null
  triggered: boolean
  lastTriggerValue: number | null
  lastTriggerTimestamp: number | null
  triggeredBy: RecordingSample | null
}

/**
 * 连续采样 + 触发记录引擎。
 * 原理：录制时临时把设备采样周期（monitor_objects.poll_interval_ms，PRD 08）调到 intervalMs，
 * 让 poller 以该速率轮询，本引擎订阅 poller/result 事件把采样攒进缓冲。
 * 最后会话结束，仅在配置和临时间隔写入身份未变化时原子恢复；冲突保留当前值并返回警告。
 * - 连续模式：记录 durationMs 后结束。
 * - 触发模式：维护 beforeMs 的环形窗口，条件命中后继续录 afterMs 再结束（带 10 分钟安全上限）。
 */
export class Recorder {
  private static readonly MAX_SESSIONS = 50 // 长期运行防内存无限增长：只保留最近 50 段录制
  private sessions = new Map<string, RecordingSession>()
  private timers = new Map<string, NodeJS.Timeout>()
  private intervalLeases = new Map<number, RecordingIntervalLease>()
  private changingInterval = new Set<number>()
  private intervalNotices: RecordingIntervalNotice[] = []
  private droppedNotices = 0
  private intervalScope: unknown
  private sessionScopes = new WeakMap<RecordingSession, unknown>()
  private static readonly MAX_INTERVAL_NOTICES = 100
  private readonly sampleLimits: RecordingSampleLimits
  private retainedSamples = 0
  private pageSnapshots = new WeakMap<RecordingSession, string>()

  constructor(private readonly ctx: any, private readonly cfg: any, limits: Partial<RecordingSampleLimits> = {}) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !['maxSamplesPerSession', 'maxTotalSamples'].includes(key))) throw new Error('invalid recording sample limits')
    this.sampleLimits = Object.freeze({ maxSamplesPerSession: limits.maxSamplesPerSession === undefined ? DEFAULT_RECORDING_SAMPLE_LIMITS.maxSamplesPerSession : limits.maxSamplesPerSession, maxTotalSamples: limits.maxTotalSamples === undefined ? DEFAULT_RECORDING_SAMPLE_LIMITS.maxTotalSamples : limits.maxTotalSamples })
    if (Object.values(this.sampleLimits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('invalid recording sample limits')
    this.intervalScope = cfg.getRecordingIntervalScope()
    ctx.on('poller/result', ({ objectId, points }: any) => this.onResult(objectId, points))
  }

  private checkSlave(slaveId?: number) {
    if (slaveId !== undefined && !validSlaveId(slaveId)) throw new Error('slaveId must be an integer byte (0–255)')
  }
  private checkAddress(area: string, address: number) {
    if (!areas.includes(area) || !Number.isInteger(address) || address < 0 || address > 65535) throw new Error('invalid recording area/address')
  }
  private checkTime(value: number, name: string, min = 0) {
    if (!Number.isSafeInteger(value) || value < min || value > MAX_TIMEOUT_MS) throw new Error(name + ' must be an integer in ' + min + '..' + MAX_TIMEOUT_MS)
  }
  private resolveSource(deviceId: number, area: string, address: number, slaveId?: number): number {
    this.checkAddress(area, address); this.checkSlave(slaveId)
    if (slaveId !== undefined) return slaveId
    const device = this.cfg.getObject(deviceId)
    const sources: number[] = device?.mode === 'slave' ? [device.slaveId ?? 1] : (this.cfg.listGroups?.(deviceId) ?? [])
      .filter((g: any) => areaForFunction(g.functionCode as ModbusFunctionCode) === area && address >= g.startAddress && address < g.startAddress + g.quantity)
      .map((g: any) => g.slaveId ?? 1)
    const unique = [...new Set(sources)]
    if (unique.length !== 1 || !validSlaveId(unique[0])) throw new Error('recording source is missing or ambiguous; specify slaveId explicitly')
    return unique[0]
  }
  private selectAddresses(deviceId: number, addresses: RecordingAddress[] | undefined, slaveId?: number): SourceAddress[] | null {
    this.checkSlave(slaveId)
    if (addresses !== undefined && !Array.isArray(addresses)) throw new Error('addresses must be an array')
    return addresses?.length ? addresses.map(a => {
      this.checkSlave(a.slaveId)
      return { area: a.area, address: a.address, slaveId: this.resolveSource(deviceId, a.area, a.address, a.slaveId ?? slaveId) }
    }) : null
  }
  private prepare(deviceId: number, intervalMs: number) {
    this.syncIntervalScope()
    if (this.changingInterval.has(deviceId)) throw new Error('recording interval operation is already in progress')
    const obj = this.cfg.getObject(deviceId)
    if (!obj) throw new Error('device ' + deviceId + ' not found')
    this.checkTime(intervalMs, 'intervalMs', 1)
    const active = [...this.sessions.values()].filter(s => s.deviceId === deviceId && s.status === 'recording')
    if (active.some(s => s.intervalMs !== intervalMs) || active.length && obj.pollIntervalMs !== intervalMs) throw new Error('device already has an active recording with a different/currently changed interval')
    if (active.length && (!this.intervalLeases.has(deviceId) || !this.cfg.recordingIntervalLeaseValid(this.intervalLeases.get(deviceId)))) throw new Error('active recording interval ownership/configuration changed; do not join or overwrite it')
    if (this.sessions.size >= Recorder.MAX_SESSIONS && ![...this.sessions.values()].some(s => s.status === 'done')) throw new Error('too many active recordings')
    if (this.retainedSamples >= this.sampleLimits.maxTotalSamples) throw new Error(`录制样本容量已满（${this.retainedSamples}/${this.sampleLimits.maxTotalSamples}）；请先list_recordings核对并删除已结束录制后重试，不会自动删除样本。`)
    return { originalPollInterval: active[0]?.originalPollInterval ?? obj.pollIntervalMs ?? 1000, active: active.length > 0 }
  }
  private addSession(session: RecordingSession, alreadyRecording: boolean): void {
    this.sessionScopes.set(session, this.cfg.getRecordingIntervalScope())
    if (!alreadyRecording) {
      this.changingInterval.add(session.deviceId)
      try {
        const result = this.cfg.acquireRecordingInterval(session.deviceId, session.intervalMs)
        this.intervalLeases.set(session.deviceId, result.lease)
        session.originalPollInterval = result.lease.originalPollInterval
        session.warnings.push(...result.warnings)
      } finally { this.changingInterval.delete(session.deviceId) }
    }
    this.sessions.set(session.id, session)
    while (this.sessions.size > Recorder.MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].filter(s => s.status === 'done').sort((a, b) => a.startedAt - b.startedAt)[0]
      if (!oldest) break
      this.retainedSamples -= oldest.samples.length
      this.sessions.delete(oldest.id)
    }
    this.syncIntervalScope()
  }

  /** 删除一段录制（含仍在录制中的，会先结束）。 */
  deleteRecording(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.finish(id, 'deleted')
    // A post-restore notification can synchronously delete the same completed session.
    if (this.sessions.get(id) === session) { this.retainedSamples -= session.samples.length; this.sessions.delete(id) }
    return true
  }

  /** 连续采样：以 intervalMs 间隔录 durationMs 秒（毫秒）。addresses 缺省 = 全部。 */
  startRecording(deviceId: number, intervalMs: number, durationMs: number, addresses?: RecordingAddress[], slaveId?: number): string {
    const prepared = this.prepare(deviceId, intervalMs)
    this.checkTime(durationMs, 'durationMs', 1)
    const selected = this.selectAddresses(deviceId, addresses, slaveId)
    const session: RecordingSession = {
      id: randomUUID(),
      deviceId,
      mode: 'continuous',
      intervalMs,
      slaveId: slaveId ?? null,
      addresses: selected,
      originalPollInterval: prepared.originalPollInterval,
      intervalRestore: 'pending', warnings: [],
      sampleLimit: this.sampleLimits.maxSamplesPerSession, completionReason: null, quotaTruncated: false, discardedSamples: 0,
      status: 'recording',
      startedAt: Date.now(),
      finishedAt: null,
      samples: [],
      trigger: null,
      triggered: false,
      lastTriggerValue: null,
      lastTriggerTimestamp: null,
      triggeredBy: null,
    }
    this.addSession(session, prepared.active)
    if (session.status === 'recording') this.timers.set(session.id, setTimeout(() => this.finish(session.id, 'duration'), durationMs))
    return session.id
  }

  /** 触发记录：trigger_address 满足 operator/阈值时，缓存触发前 beforeMs + 触发后 afterMs。 */
  startTriggerRecording(deviceId: number, intervalMs: number, triggerArea: string, triggerAddress: number, operator: string, threshold: number, beforeMs: number, afterMs: number, addresses?: RecordingAddress[], slaveId?: number, triggerSlaveId?: number): string {
    const prepared = this.prepare(deviceId, intervalMs)
    this.checkTime(beforeMs, 'beforeMs'); this.checkTime(afterMs, 'afterMs')
    if (!operators.includes(operator) || !Number.isFinite(threshold)) throw new Error('invalid trigger operator/threshold')
    this.checkSlave(triggerSlaveId)
    const selected = this.selectAddresses(deviceId, addresses, slaveId)
    const triggerSource = this.resolveSource(deviceId, triggerArea, triggerAddress, triggerSlaveId ?? slaveId)
    const session: RecordingSession = {
      id: randomUUID(),
      deviceId,
      mode: 'trigger',
      intervalMs,
      slaveId: slaveId ?? null,
      addresses: selected,
      originalPollInterval: prepared.originalPollInterval,
      intervalRestore: 'pending', warnings: [],
      sampleLimit: this.sampleLimits.maxSamplesPerSession, completionReason: null, quotaTruncated: false, discardedSamples: 0,
      status: 'recording',
      startedAt: Date.now(),
      finishedAt: null,
      samples: [],
      trigger: { slaveId: triggerSource, area: triggerArea, address: triggerAddress, operator: operator as RecordingTrigger['operator'], threshold, beforeMs, afterMs },
      triggered: false,
      lastTriggerValue: null,
      lastTriggerTimestamp: null,
      triggeredBy: null,
    }
    this.addSession(session, prepared.active)
    // 安全上限：10 分钟仍不触发则结束，避免无限录制
    if (session.status === 'recording') this.timers.set(session.id, setTimeout(() => this.finish(session.id, 'trigger-timeout'), 10 * 60 * 1000))
    return session.id
  }

  getRecording(id: string): RecordingSession | null {
    this.syncIntervalScope()
    return this.sessions.get(id) ?? null
  }
  getSampleStorageStatus() { return Object.freeze({ ...this.sampleLimits, retainedSamples: this.retainedSamples, remainingSamples: this.sampleLimits.maxTotalSamples - this.retainedSamples }) }
  /** Completed samples never roll/prune. Bind continuation to this retained session; no full-array copy. */
  getRecordingPage(id: string, offset = 0, limit = DEFAULT_RECORDING_PAGE_SIZE, snapshotId?: string) {
    const reject = (statusCode: number, code: string, message: string): never => { throw Object.assign(new Error(message), { statusCode, code }) }
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDING_PAGE_SIZE || snapshotId !== undefined && (typeof snapshotId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(snapshotId))) return reject(400, 'RECORDING_PAGE_INPUT_INVALID', '分页参数无效：起点须非负整数，每页1..1000条，快照须为原snapshotId。')
    const session = this.getRecording(id)
    if (!session) return reject(404, 'RECORDING_NOT_FOUND', '录制不存在或已被删除/淘汰；不会重新开始或改读其他录制。')
    if (session.status !== 'done' || session.finishedAt === null) return reject(409, 'RECORDING_NOT_FINISHED', '录制仍在进行；请用list_recordings查看进度，结束后再分页。不会为读取自动停止录制。')
    if (offset > session.samples.length) return reject(400, 'RECORDING_PAGE_INPUT_INVALID', '分页起点超出保留样本范围，请核对原页信息。')
    if (offset > 0 && snapshotId === undefined) return reject(428, 'RECORDING_PAGE_SNAPSHOT_REQUIRED', '续页必须携带首个分页返回的snapshotId；请从offset=0开始核对。')
    let snapshot = this.pageSnapshots.get(session)
    if (snapshotId !== undefined && snapshotId !== snapshot) return reject(409, 'RECORDING_PAGE_SNAPSHOT_MISMATCH', '快照不属于这段录制，未返回样本；请核对原recording_id及snapshotId。')
    if (!snapshot) { snapshot = randomUUID(); this.pageSnapshots.set(session, snapshot) }
    const { samples: all, ...rest } = session
    const samples = Object.freeze(all.slice(offset, offset + limit).map(sample => Object.freeze({ ...sample })))
    const metadata = Object.freeze({ ...rest, addresses: rest.addresses && Object.freeze(rest.addresses.map(address => Object.freeze({ ...address }))), trigger: rest.trigger && Object.freeze({ ...rest.trigger }), triggeredBy: rest.triggeredBy && Object.freeze({ ...rest.triggeredBy }), warnings: Object.freeze([...rest.warnings]) })
    const next = offset + samples.length
    return Object.freeze({ recording: metadata, snapshotId: snapshot, configurationScopeCurrent: this.sessionScopes.get(session) === this.intervalScope, coverage: 'retained-samples-only' as const, totalSamples: all.length, offset, limit, returnedSamples: samples.length, hasMore: next < all.length, nextOffset: next < all.length ? next : null, samples })
  }

  /** Read-only current metadata plus bounded completion notices, independent of sample deletion/eviction. */
  getRecordingIntervalStatus(deviceId: number): RecordingIntervalStatus {
    this.syncIntervalScope()
    const row = this.cfg.getObject(deviceId)
    return parseRecordingIntervalStatus({ available: true, deviceId, checkedAt: Date.now(), current: row ? { name: typeof row.name === 'string' ? row.name : null, mode: typeof row.mode === 'string' ? row.mode : null, intervalMs: typeof row.pollIntervalMs === 'number' && Number.isFinite(row.pollIntervalMs) ? row.pollIntervalMs : null } : null,
      active: [...this.sessions.values()].filter(s => this.sessionScopes.get(s) === this.intervalScope && s.deviceId === deviceId && s.status === 'recording').map(s => ({ recordingId: s.id, intervalMs: s.intervalMs })), notices: this.intervalNotices.filter(n => n.deviceId === deviceId), retention: { scope: 'process', limit: Recorder.MAX_INTERVAL_NOTICES, dropped: this.droppedNotices } }, deviceId)
  }
  private syncIntervalScope() {
    const scope = this.cfg.getRecordingIntervalScope()
    if (scope !== this.intervalScope) { this.intervalScope = scope; this.intervalNotices = []; this.droppedNotices = 0 }
    for (const session of this.sessions.values()) {
      if (session.status !== 'recording' || this.sessionScopes.get(session) === scope) continue
      session.status = 'done'; session.finishedAt = Date.now(); session.completionReason = 'configuration-changed'; session.intervalRestore = 'preserved'
      session.warnings.push('配置已切换，录制已结束并保留已有样本；未恢复旧配置间隔，也未修改当前配置。')
      const timer = this.timers.get(session.id); if (timer) clearTimeout(timer)
      this.timers.delete(session.id); this.intervalLeases.delete(session.deviceId)
    }
  }

  listRecordings() {
    this.syncIntervalScope()
    return [...this.sessions.values()].map((s) => ({
      id: s.id, deviceId: s.deviceId, mode: s.mode, status: s.status,
      slaveId: s.slaveId, addresses: s.addresses, trigger: s.trigger,
      sampleCount: s.samples.length, triggered: s.triggered, startedAt: s.startedAt, finishedAt: s.finishedAt,
      intervalRestore: s.intervalRestore, warnings: [...s.warnings],
      sampleLimit: s.sampleLimit, completionReason: s.completionReason, quotaTruncated: s.quotaTruncated, discardedSamples: s.discardedSamples,
    }))
  }

  stopRecording(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.finish(id)
    return true
  }

  private sample(p: InputSample): RecordingSample {
    return { ts: p.timestamp, area: p.area, address: p.address, rawValue: p.rawValue, quality: p.quality, slaveId: p.slaveId ?? null, batchId: p.batchId ?? null, sourceVerified: validSlaveId(p.slaveId) }
  }
  private onResult(objectId: number, points: InputSample[]): void {
    this.syncIntervalScope()
    for (const s of this.sessions.values()) {
      if (s.status !== 'recording' || s.deviceId !== objectId) continue
      const attributable = points.filter(p => (p.objectId === undefined || p.objectId === objectId) && (p.slaveId == null || validSlaveId(p.slaveId)))
      const matches = (p: InputSample) => s.addresses ? s.addresses.some(a => a.area === p.area && a.address === p.address && a.slaveId === p.slaveId) : s.slaveId === null || s.slaveId === p.slaveId
      const cutoff = s.mode === 'trigger' && !s.triggered ? Date.now() - s.trigger!.beforeMs : null
      if (cutoff !== null) {
        const retained = s.samples.filter(sm => new Date(sm.ts).getTime() >= cutoff)
        this.retainedSamples -= s.samples.length - retained.length; s.samples = retained
      }
      const incoming = attributable.filter(p => matches(p) && (cutoff === null || Date.parse(p.timestamp) >= cutoff))
      const room = Math.max(0, Math.min(this.sampleLimits.maxSamplesPerSession - s.samples.length, this.sampleLimits.maxTotalSamples - this.retainedSamples))
      const accepted = Math.min(room, incoming.length)
      for (let index = 0; index < accepted; index++) { s.samples.push(this.sample(incoming[index])); this.retainedSamples++ }
      if (s.mode === 'trigger' && !s.triggered) {
        this.maybeTrigger(s, attributable) // Trigger selection is independent of capture addresses.
      }
      if (accepted < incoming.length) {
        s.quotaTruncated = true; s.discardedSamples = incoming.length - accepted
        const reason = s.samples.length >= this.sampleLimits.maxSamplesPerSession ? 'sample-limit' : 'storage-limit'
        const warning = `录制达到${reason === 'sample-limit' ? '单段' : '全局'}样本上限，已提前结束；保留${s.samples.length}个原始样本，当前事件有${s.discardedSamples}个匹配样本未保留，之后未继续录制。请缩短时长/减少点位，或核对并删除已结束录制后重试。`
        s.warnings.push(warning)
        try { this.cfg.log('WARN', 'recorder', warning + ' recording=' + s.id) } catch { s.warnings.push('样本上限日志未保存，录制结果仍保留提前结束说明。') }
        this.finish(s.id, reason)
      }
    }
  }

  private maybeTrigger(s: RecordingSession, points: InputSample[]): void {
    const candidates = points.filter(p => p.slaveId === s.trigger!.slaveId && p.area === s.trigger!.area && p.address === s.trigger!.address)
    if (!candidates.length) return // Other/unknown sources must not update a changed baseline.
    const p = candidates[0], time = Date.parse(p.timestamp)
    if (candidates.length !== 1 || p.quality !== 'good' || !Number.isInteger(p.rawValue) || p.rawValue < 0 || p.rawValue > 65535 || !Number.isFinite(time)) { s.lastTriggerValue = null; return }
    if (time < s.startedAt || s.lastTriggerTimestamp !== null && time < s.lastTriggerTimestamp) return
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
    s.lastTriggerTimestamp = time
    if (!hit) return
    s.triggered = true
    s.triggeredBy = this.sample(p)
    const old = this.timers.get(s.id)
    if (old) clearTimeout(old)
    this.timers.set(s.id, setTimeout(() => this.finish(s.id, 'trigger-window'), s.trigger!.afterMs))
  }

  private finish(id: string, reason: RecordingCompletionReason = 'stopped'): void {
    this.syncIntervalScope()
    const s = this.sessions.get(id)
    if (!s || s.status !== 'recording') return
    s.status = 'done'
    s.completionReason = reason
    s.finishedAt = Date.now()
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    const otherActive = [...this.sessions.values()].some(other => other.id !== id && other.deviceId === s.deviceId && other.status === 'recording')
    if (otherActive) { s.intervalRestore = 'shared'; return }
    const lease = this.intervalLeases.get(s.deviceId)
    this.intervalLeases.delete(s.deviceId)
    this.changingInterval.add(s.deviceId)
    try {
      if (!lease) throw new Error('missing recording interval ownership')
      const result = this.cfg.restoreRecordingInterval(lease)
      s.intervalRestore = result.state; s.warnings.push(...result.warnings)
    } catch { s.intervalRestore = 'uncertain'; s.warnings.push('录制已结束，但恢复间隔结果待核实；请人工核对当前采样周期，勿自动重复恢复。') }
    finally { this.changingInterval.delete(s.deviceId) }
    if (s.intervalRestore === 'preserved' || s.intervalRestore === 'uncertain') {
      this.syncIntervalScope()
      if (this.sessionScopes.get(s) !== this.intervalScope) { s.warnings.push('录制属于此前打开的配置，核对记录未归入当前同编号设备。'); return }
      try { this.cfg.log('WARN', 'recorder', `录制间隔待核对 recording=${s.id} device=${s.deviceId} state=${s.intervalRestore} original=${s.originalPollInterval}ms recording=${s.intervalMs}ms；未自动重复恢复，请核对当前配置。`) }
      catch { s.warnings.push('间隔核对日志未保存；本次运行仍可查看核对记录。') }
      this.intervalNotices.unshift(Object.freeze({ recordingId: s.id, deviceId: s.deviceId, state: s.intervalRestore, originalIntervalMs: s.originalPollInterval, recordingIntervalMs: s.intervalMs, finishedAt: s.finishedAt!, warnings: Object.freeze([...s.warnings]) }))
      if (this.intervalNotices.length > Recorder.MAX_INTERVAL_NOTICES) { this.intervalNotices.pop(); this.droppedNotices++ }
    }
  }
}
