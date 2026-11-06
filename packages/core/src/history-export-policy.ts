export const HISTORY_EXPORT_RAW_LIMIT = 200_000

export class HistoryExportLimitError extends Error {
  readonly code = 'HISTORY_EXPORT_LIMIT'
  constructor(readonly limit = HISTORY_EXPORT_RAW_LIMIT) {
    super(`History export exceeds ${limit} raw rows. No file was generated; narrow the time range.`)
    this.name = 'HistoryExportLimitError'
  }
}
