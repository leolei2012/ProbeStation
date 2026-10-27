/** Keep real samples, including extrema and invalid readings, in each time bucket. */
export interface CurveSample { time: number; value: number | null; words: number[]; qualities: string[] }
export class CurveSampler {
  private buckets = new Map<number, { first: CurveSample; last: CurveSample; min: CurveSample; max: CurveSample; invalid?: CurveSample }>()
  count = 0
  constructor(private start: number, private bucketMs: number) {}
  add(sample: CurveSample) {
    this.count++
    const key = Math.floor((sample.time - this.start) / this.bucketMs)
    const bucket = this.buckets.get(key)
    if (!bucket) { this.buckets.set(key, { first: sample, last: sample, min: sample, max: sample, invalid: sample.value === null ? sample : undefined }); return }
    bucket.last = sample
    if (sample.value === null) bucket.invalid ??= sample
    else {
      if (bucket.min.value === null || sample.value < bucket.min.value) bucket.min = sample
      if (bucket.max.value === null || sample.value > bucket.max.value) bucket.max = sample
    }
  }
  samples(): CurveSample[] {
    return [...this.buckets.values()].flatMap(b => [...new Set([b.first, b.min, b.max, b.invalid, b.last].filter((s): s is CurveSample => !!s))]).sort((a, b) => a.time - b.time)
  }
}
