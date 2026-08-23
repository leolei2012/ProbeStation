import { Recorder } from '../packages/mcp/src/recorder.ts'

// ============================================================
// 连续采样 + 触发记录回归
// 直接驱动 Recorder（监听 poller/result 事件），验证两种模式。
// ============================================================

const listeners: Record<string, (payload: any) => void> = {}
const ctx = { on: (event: string, fn: any) => { listeners[event] = fn } }
const emit = (event: string, payload: any) => listeners[event]?.(payload)

const objects = new Map<number, { id: number; pollIntervalMs: number; dataRetainSeconds: number | null }>()
objects.set(1, { id: 1, pollIntervalMs: 200, dataRetainSeconds: null })
const cfg = {
  getObject: (id: number) => objects.get(id),
  updateObject: (id: number, fields: Record<string, unknown>) => { const o = objects.get(id); if (o) Object.assign(o, fields) },
  listObjects: () => [...objects.values()],
}

const recorder = new Recorder(ctx as any, cfg as any)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 1) 连续采样：录 400ms，期间临时把设备采样周期调到 50，结束后恢复 200
{
  const id = recorder.startRecording(1, 50, 400)
  if (cfg.getObject(1)!.pollIntervalMs !== 50) throw new Error('poll rate not set to 50 during recording')
  for (let i = 0; i < 8; i++) {
    emit('poller/result', { objectId: 1, points: [{ objectId: 1, area: 'holding-register', address: 0, timestamp: new Date().toISOString(), rawValue: i, quality: 'good' }] })
    await sleep(40)
  }
  await sleep(300)
  const rec = recorder.getRecording(id)!
  if (rec.status !== 'done') throw new Error('continuous recording not done: ' + rec.status)
  if (rec.samples.length < 3) throw new Error('too few samples: ' + rec.samples.length)
  if (cfg.getObject(1)!.pollIntervalMs !== 200) throw new Error('poll rate not restored: ' + cfg.getObject(1)!.pollIntervalMs)
  console.log('1) continuous recording OK: ' + rec.samples.length + ' samples, poll restored to 200')
}

// 2) 触发记录：trigger addr 0x100，>100 时触发，缓存 before 200ms + after 300ms
{
  const id = recorder.startTriggerRecording(1, 50, 'holding-register', 0x100, '>', 100, 200, 300)
  for (let v = 0; v <= 150; v += 10) {
    emit('poller/result', { objectId: 1, points: [{ objectId: 1, area: 'holding-register', address: 0x100, timestamp: new Date().toISOString(), rawValue: v, quality: 'good' }] })
    await sleep(30)
  }
  await sleep(400)
  const rec = recorder.getRecording(id)!
  if (!rec.triggered) throw new Error('trigger not fired')
  if (rec.status !== 'done') throw new Error('trigger recording not done: ' + rec.status)
  const max = Math.max(...rec.samples.map((s) => s.rawValue))
  const min = Math.min(...rec.samples.map((s) => s.rawValue))
  if (max < 110) throw new Error('after-trigger samples not captured; max=' + max)
  console.log('2) trigger recording OK: triggered, ' + rec.samples.length + ' samples (raw range ' + min + '..' + max + ')')
}

console.log('RECORDER TEST OK')
process.exit(0)
