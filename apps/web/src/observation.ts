export interface Sample { rawValue: number; quality: string; timestamp: string; timestampMs?: number }

export function sampleTime(sample?: Sample): number | null {
  if (!sample) return null
  const ms = sample.timestampMs ?? Date.parse(sample.timestamp)
  return Number.isFinite(ms) ? ms : null
}

/** Allow two estimated group cycles, including request timeouts and chunk gaps. */
export function staleAfterMs(interval: number, timeout: number, groups: Array<{ isActive: number; quantity: number; functionCode: number }>): number {
  const cycle = groups.filter(g => g.isActive).reduce((sum, g) => {
    const chunks = Math.max(1, Math.ceil(g.quantity / (g.functionCode <= 2 ? 2000 : 125)))
    return sum + chunks * (Math.max(0, interval) + Math.max(0, timeout))
  }, 0)
  return Math.max(5000, cycle * 2)
}

export function pointHealth(samples: Array<Sample | undefined>, now: number, threshold: number, paused: boolean, fault: boolean) {
  const times = samples.map(sampleTime)
  const known = times.filter((v): v is number => v !== null)
  const oldest = known.length ? Math.min(...known) : null
  const missing = samples.some(s => !s)
  const stale = paused || fault || samples.some(s => s && s.quality !== 'good') || times.some(t => t === null || now - t > threshold)
  return { missing, stale, timestamp: oldest, ageSeconds: oldest === null ? null : Math.max(0, Math.floor((now - oldest) / 1000)) }
}
