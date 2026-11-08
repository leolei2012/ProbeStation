import { Writable } from 'node:stream'
import ExcelJS from 'exceljs'
import { areaForFunction, historyVerificationLabel } from '../../packages/core/src/index.ts'
import { historyColumnNames } from '../../packages/sink/src/history-columns.ts'
import type { Sink } from '../../packages/sink/src/index.ts'

// Offline candidate only. No production imports this file. Uses the actual collector, including its guards.
// Layout/formatting intentionally mirrors Sink at 7cdbd75; contract tests must detect future drift.
function localTimestamp(ts: string, offset: number) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts || ''
  const shifted = new Date(date.getTime() + offset * 60000), pad = (n: number) => String(n).padStart(2, '0')
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + (shifted.getUTCMilliseconds() ? '.' + String(shifted.getUTCMilliseconds()).padStart(3, '0') : '')
}
function timezone(offset: number) { if (offset === 0) return 'UTC'; const n = Math.abs(offset); return 'UTC' + (offset > 0 ? '+' : '-') + String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') }
export interface CandidateOptions {
  signal?: AbortSignal
  onRow?: (count: number) => void
  onPhase?: (phase: string) => void
  beforeCommit?: () => Promise<void>
  outputError?: Error
  failAfterOutputBytes?: number
  onOutputChunk?: (acceptedBytes: number) => void
  onCleanup?: (state: { finished: boolean; destroyed: boolean; returnedBytes: number; bufferedBytes: number }) => void
}
export async function candidateHistoryXlsx(sink: Sink, args: Parameters<Sink['exportXlsx']>, options: CandidateOptions = {}): Promise<Buffer> {
  const [objectId, start, end, registerIds, offset = 0] = args, check = () => options.signal?.throwIfAborted()
  check()
  const { registers, tsOrder, formatted, verification } = await (sink as any).collect(objectId, start, end, registerIds, 'xlsx')
  options.onPhase?.('afterCollect'); check()
  const names = historyColumnNames(registers, [`timestamp(${timezone(offset)})`, `timestamp (${timezone(offset)})`])
  const chunks: Buffer[] = []; let error: unknown, failed = false, returnedBytes = 0, acceptedBytes = 0, complete = false, stopped = false
  const cleanupErrors: unknown[] = []
  let rejectFailure!: (reason: unknown) => void
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject }); void failure.catch(() => {})
  const fail = (reason: unknown) => { if (!failed) { failed = true; error = reason; rejectFailure(reason) } }
  const stream = new Writable({ write(chunk: Buffer, _encoding, done) {
    if (options.outputError && acceptedBytes >= (options.failAfterOutputBytes ?? 0)) return done(options.outputError)
    if (options.signal?.aborted) return done(options.signal.reason)
    chunks.push(Buffer.from(chunk)); acceptedBytes += chunk.length; options.onOutputChunk?.(acceptedBytes); done()
  } })
  stream.on('error', fail)
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false })
  // ExcelJS has no public writer abort. This private dependency is a production adoption risk.
  const zip = (writer as any).zip
  zip.on('error', fail)
  const stop = () => {
    if (stopped) return
    stopped = true
    try { zip.abort() } catch (reason) { cleanupErrors.push(reason) }
    try { if (!stream.destroyed) stream.destroy() } catch (reason) { cleanupErrors.push(reason) }
  }
  const abort = () => { fail(options.signal!.reason); stop() }
  options.signal?.addEventListener('abort', abort, { once: true })
  const pending = <T,>(work: Promise<T>) => Promise.race([work, failure])
  try {
    check(); if (failed) throw error
    const data = writer.addWorksheet('data')
    data.columns = [
      { header: `timestamp (${timezone(offset)})`, key: 'ts', width: 24 },
      ...registers.flatMap((r: any, i: number) => [{ header: names[i], key: `r${r.id}`, width: 24 }, { header: names[i] + '__batch_status', key: `s${r.id}`, width: 28 }, { header: names[i] + '__automatic_eligible', key: `a${r.id}`, width: 32 }]),
    ]
    data.getRow(1).commit()
    let count = 0
    for (const ts of tsOrder) {
      check(); if (failed) throw error
      const row: Record<string, unknown> = { ts: localTimestamp(ts, offset) }, values = formatted.get(ts)!
      for (const r of registers) { const state = verification.get(ts)!.get(r.id)!; row[`r${r.id}`] = values.get(r.id) ?? null; row[`s${r.id}`] = historyVerificationLabel[state as keyof typeof historyVerificationLabel]; row[`a${r.id}`] = state === 'verified' }
      data.addRow(row).commit(); options.onRow?.(++count)
      if (count % 128 === 0) await pending(new Promise<void>(resolve => setImmediate(resolve)))
    }
    data.commit()
    const notes = writer.addWorksheet('历史身份说明', { views: [{ state: 'frozen', ySplit: 5 }] })
    notes.columns = [38, 12, 12, 20, 22, 12, 18, 48].map(width => ({ width }))
    for (const text of [
      '批次/来源未验证的值仅供查看，不可作为自动 PASS/FAIL 依据。无法归属从站、混批或缺字等未知值留空。',
      'automatic_eligible 只表示目标从站来源明确、完整同批且质量有效，不表示测试通过；本程序未生成 PASS/FAIL。',
      '重名列附从站和点位ID；从站指当前配置目标，不能替代逐行批次/来源状态。原始别名以JSON文本保存。',
    ]) notes.addRow([text]).commit()
    notes.addRow([]).commit()
    const header = notes.addRow(['数据列', '点位ID', '分组ID', '从站（当前配置）', '数据区', '地址', 'dtype', '原始别名(JSON)']); header.font = { bold: true }; header.commit()
    registers.forEach((r: any, i: number) => notes.addRow([names[i], r.id, r.groupId ?? null, r.slaveId ?? null, areaForFunction(r.functionCode), r.startAddress, r.dataType, JSON.stringify(r.alias ?? null)]).commit())
    notes.commit(); options.onPhase?.('beforeCommit')
    await options.beforeCommit?.(); check(); if (failed) throw error
    await pending(writer.commit()); check(); if (failed) throw error
    if (!stream.writableFinished) throw new Error('Candidate output did not finish')
    const output = Buffer.concat(chunks); returnedBytes = output.length; complete = true; options.onPhase?.('output'); return output
  } catch (reason) { fail(reason); throw reason }
  finally {
    options.signal?.removeEventListener('abort', abort)
    if (!complete) stop()
    chunks.length = 0
    try { options.onCleanup?.({ finished: stream.writableFinished, destroyed: stream.destroyed, returnedBytes, bufferedBytes: acceptedBytes }) } catch (reason) { cleanupErrors.push(reason) }
    if (cleanupErrors.length) throw new AggregateError(failed ? [error, ...cleanupErrors] : cleanupErrors, 'Candidate cleanup failed', { cause: failed ? error : undefined })
  }
}
