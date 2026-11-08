import React from 'react'

export function HistoryPaginationNotice({ outOfRange, onRestart, english = false }: { outOfRange: boolean; onRestart: () => void; english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh
  return <div className="chart-hint history-pagination-notice" role="note">
    <p>{text('每页独立读取，并非跨页快照。翻页期间的新增、迟到写入或清理可能造成重复或遗漏，总数相同也不能证明数据未变化。需要重新核对时，可从首页重新读取；这仍不保证完整性。', 'Each page is read independently, not from a cross-page snapshot. New or late samples and cleanup between pages may cause duplicates or omissions; an unchanged total does not prove unchanged data. Read again from the first page to review; this still does not guarantee completeness.')}</p>
    {outOfRange && <div role="status"><p>{text('当前页已超出本次返回的页数，可能发生清理或数据变化。请回到首页重新读取并核对。', 'The requested page is beyond the page count returned now, possibly after cleanup or other data changes. Read again from the first page and review.')}</p><button type="button" className="btn" onClick={onRestart}>{text('回到首页重新读取', 'Read again from first page')}</button></div>}
  </div>
}
