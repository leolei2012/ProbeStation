import React from 'react'
import { LIVE_POINT_FILTERS, type LivePointFilter } from './live-point-filter'

export function LivePointFilters({ search, source, sources, mode, counts, rulesReady, ruleError, readingRules = false, onRetryRules, onSearch, onSource, onMode, onClear, english = false }: {
  search: string; source: string; sources: readonly string[]; mode: LivePointFilter; counts: Record<LivePointFilter, number>; rulesReady: boolean; ruleError: boolean
  onSearch: (value: string) => void; onSource: (value: string) => void; onMode: (value: LivePointFilter) => void; onClear: () => void; english?: boolean
  readingRules?: boolean; onRetryRules?: () => void
}) {
  const text = (zh: string, en: string) => english ? en : zh
  const names = { all: text('全部点位', 'All points'), attention: text('需关注', 'Needs attention'), alarm: text('行内已触发告警', 'Triggered alarms (rows)'), data: text('数据异常/过期/暂停', 'Invalid / stale / paused'), unknown: text('行内规则结果待定', 'Unknown rule results (rows)') }
  const filtered = !!search.trim() || !!source || mode !== 'all'
  return <section className="live-point-filters" aria-label={text('实时点位筛选', 'Live point filters')}>
    <div className="toolbar"><label className="live-point-search">{text('搜索点位', 'Find points')}<input className="hist-input" value={search} placeholder={text('名称、分组、0x地址、id:编号、slave:从站', 'Name, group, 0x address, id:number, slave:number')} onChange={e => onSearch(e.target.value)} /></label>
      <label>{text('配置从站', 'Configured slave')}<select value={source} onChange={e => onSource(e.target.value)}><option value="">{text('全部从站', 'All slaves')}</option>{sources.map(value => <option key={value} value={value}>{value === '?' ? text('来源未知', 'Unknown source') : text('从站 ', 'Slave ') + value}</option>)}</select></label>
      <button type="button" className="btn" disabled={!filtered} onClick={onClear}>{text('清除全部筛选', 'Clear all filters')}</button>
    </div>
    <div className="live-point-status-filters" role="group" aria-label={text('按状态筛选', 'Filter by status')}>{LIVE_POINT_FILTERS.map(value => <button key={value} type="button" className={'btn' + (mode === value ? ' selected' : '')} aria-pressed={mode === value} onClick={() => onMode(value)}>{names[value]} <strong>{counts[value]}</strong></button>)}</div>
    <p className="chart-hint" role="status">{text('数量按当前搜索和从站统计，分组摘要仍代表完整分组。需关注包含行内已触发告警、数据异常和已知规则的待定结果；被多字点覆盖的行只列入全部，相关规则请核对顶部摘要和点表配置。', 'Counts use the current search and slave scope; group summaries cover full groups. Attention includes triggered row alarms, data issues and unknown results for loaded rules. Rows covered by multiword points appear only in All; check their rules in the top summary and point definitions.')}</p>
    {(!rulesReady || ruleError) && <div className="chart-hint warn" role="status"><p>{text(ruleError ? '规则读取失败，告警筛选可能不完整，当前保留已载入规则；数量为0不代表无告警。' : '规则尚未核实，告警筛选暂不完整；数量为0不代表无告警。', ruleError ? 'Rule loading failed; alarm filters may be incomplete and retain loaded rules. Zero does not prove no alarms.' : 'Rules are unverified. Alarm filters are incomplete; zero does not prove no alarms.')}</p>{onRetryRules && <button type="button" className="btn" disabled={readingRules} onClick={onRetryRules}>{text(readingRules ? '正在读取规则…' : '重新读取规则', readingRules ? 'Reading rules…' : 'Read rules again')}</button>}</div>}
    <p className="alarm-rule-refresh" role="status">{rulesReady && !ruleError && readingRules ? text('正在刷新规则，筛选按上次读取结果。', 'Refreshing rules; filters use the last read.') : null}</p>
    {filtered && <p className="chart-hint">{text('筛选期间临时展开匹配分组；清除全部筛选后恢复原折叠状态。只改变页面显示，不改变采集或规则。', 'Matching groups expand while filtering; clearing filters restores previous folds. Display only; sampling and rules are unchanged.')}</p>}
  </section>
}
