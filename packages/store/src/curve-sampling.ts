/** Keep real samples, including extrema and invalid readings, in each time bucket. */
import type { HistoryVerification } from '../../core/src/history-integrity.ts'
export interface CurveSample { time: number; value: number | null; words: number[]; qualities: string[]; verification?: HistoryVerification; segment?: number }
export class CurveSampler {
  private buckets = new Map<number, { first: CurveSample; last: CurveSample; min: CurveSample; max: CurveSample; invalid?: CurveSample; unverified?: CurveSample }>()
  private integrityCounts = { verified: 0, unverified: 0, unknown: 0 }
  count = 0
  private invalidCount = 0
  constructor(private start: number, private bucketMs: number) {}
  add(sample: CurveSample) {
    this.count++
    const verification = sample.verification ?? (sample.value === null ? 'unknown' : 'unverified')
    this.integrityCounts[verification]++
    if (sample.value === null) this.invalidCount++
    const key = Math.floor((sample.time - this.start) / this.bucketMs)
    const bucket = this.buckets.get(key)
    if (!bucket) { this.buckets.set(key, { first: sample, last: sample, min: sample, max: sample, invalid: sample.value === null ? sample : undefined, unverified: verification === 'unverified' ? sample : undefined }); return }
    bucket.last = sample
    if (verification === 'unverified') bucket.unverified ??= sample
    if (sample.value === null) bucket.invalid ??= sample
    else {
      if (bucket.min.value === null || sample.value < bucket.min.value) bucket.min = sample
      if (bucket.max.value === null || sample.value > bucket.max.value) bucket.max = sample
    }
  }
  samples(): CurveSample[] {
    return [...this.buckets.values()].flatMap(b => [...new Set([b.first, b.min, b.max, b.invalid, b.unverified, b.last].filter((s): s is CurveSample => !!s))]).sort((a, b) => a.time - b.time)
  }
  integrity() { return { ...this.integrityCounts } }
  /** Counts cover the full decoded input, before display downsampling. */
  summary() {
    return { sourceSamples: this.count, validSamples: this.count - this.invalidCount, invalidSamples: this.invalidCount }
  }
}
