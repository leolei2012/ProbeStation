import { registerWidth } from './codec.ts'

/** New samples carry response identity. Legacy samples retain their existing checks. */
export function sameResponseBatch(words: Array<{ batchId?: string | null } | undefined>): boolean {
  if (words.length < 2) return true
  if (words.some(word => !word)) return false
  const ids = words.map(word => word!.batchId)
  if (ids.every(id => id == null)) return true
  return typeof ids[0] === 'string' && ids[0].length > 0 && ids.every(id => id === ids[0])
}

/** Keep every effective multiword point inside one Modbus response. */
export function planReadChunks(start: number, quantity: number, limit: number, registers: Array<{ startAddress: number; dataType: string }>) {
  const spans: Array<{ start: number; end: number }> = []
  let covered = -Infinity
  for (const r of [...registers].sort((a, b) => a.startAddress - b.startAddress)) {
    if (r.startAddress < covered) continue
    covered = r.startAddress + registerWidth(r.dataType)
    if (r.startAddress >= start && covered <= start + quantity) spans.push({ start: r.startAddress, end: covered })
  }
  const chunks: Array<{ start: number; quantity: number }> = []
  for (let cursor = start; cursor < start + quantity;) {
    let end = Math.min(start + quantity, cursor + limit)
    for (const span of spans) if (span.start < end && span.end > end) end = Math.min(end, span.start)
    if (end <= cursor) throw new Error('Point width exceeds protocol read limit')
    chunks.push({ start: cursor, quantity: end - cursor }); cursor = end
  }
  return chunks
}
