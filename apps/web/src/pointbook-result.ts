export interface PointBookReport { groups: number; registers: number; errors: string[]; warnings: string[] }
export class InvalidPointBookReportError extends Error {
  constructor() { super('Invalid point book import report'); this.name = 'InvalidPointBookReportError' }
}
export function parsePointBookReport(value: unknown): PointBookReport {
  const report = value as Partial<PointBookReport> | null
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string')
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Number.isSafeInteger(report.groups) || report.groups! < 0 || !Number.isSafeInteger(report.registers) || report.registers! < 0 || !strings(report.errors) || (report.warnings !== undefined && !strings(report.warnings))) throw new InvalidPointBookReportError()
  return { groups: report.groups!, registers: report.registers!, errors: [...report.errors], warnings: [...(report.warnings ?? [])] }
}
export function pointBookReportKind(report: PointBookReport | null): 'completed' | 'rejected' | 'uncertain' {
  return !report ? 'uncertain' : !report.errors.length ? 'completed' : report.groups || report.registers ? 'uncertain' : 'rejected'
}
/** Single user-initiated write. Do not automatically retry or abort an uncertain import. */
export async function uploadPointBook(objectId: number, file: Blob, fetcher: typeof fetch = fetch): Promise<PointBookReport> {
  const response = await fetcher('/api/monitor_objects/' + objectId + '/points/book', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    if (response.status === 503 && data?.version === 1 && data.code === 'CONFIG_WRITE_NOT_STARTED' && data.outcome === 'not-applied') {
      try { const report = parsePointBookReport(data.report); if (report.groups === 0 && report.registers === 0 && report.errors.length > 0) return report } catch { /* An incomplete or contradictory receipt stays uncertain. */ }
    }
    const detail = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : ''
    throw new Error(`HTTP ${response.status}${detail ? ': ' + detail.slice(0, 1000) : ''}`)
  }
  let data: unknown
  try { data = await response.json() } catch { throw new InvalidPointBookReportError() }
  return parsePointBookReport(data)
}
