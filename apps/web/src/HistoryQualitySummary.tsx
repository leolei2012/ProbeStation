import type { HistorySeries } from './history-curve'

/** Source counts must never be inferred from the smaller display sample set. */
export function HistoryQualitySummary({ series, registers, t }: {
  series: HistorySeries[]; registers: { id: number; alias: string | null; startAddress: number }[]; t: (key: string) => string
}) {
  const rows = series.filter(s => s.summary)
  if (!rows.length) return null
  return <details className="history-quality-summary">
    <summary>{t('histQualityTitle')}</summary>
    <p className="chart-hint">{t('histQualityHint')}</p>
    <div className="history-table-scroll"><table className="reg hist-table">
      <thead><tr><th>{t('histQualityPoint')}</th><th>{t('histQualitySource')}</th><th>{t('histQualityValid')}</th><th>{t('histQualityInvalid')}</th><th>{t('histQualityRate')}</th><th>{t('histQualityVerified')}</th><th>{t('histQualityUnverified')}</th><th>{t('histQualityUnknown')}</th></tr></thead>
      <tbody>{rows.map(s => {
        const r = registers.find(r => r.id === s.id), stats = s.summary!
        return <tr key={s.id}><td>{r?.alias || '#' + (r?.startAddress ?? s.id)}</td><td>{stats.sourceSamples.toLocaleString()}</td><td>{stats.validSamples.toLocaleString()}</td><td className={stats.invalidSamples ? 'warn' : ''}>{stats.invalidSamples.toLocaleString()}</td><td>{stats.sourceSamples ? (100 * stats.validSamples / stats.sourceSamples).toFixed(1) + '%' : '—'}</td><td>{s.integrity?.verified ?? '—'}</td><td>{s.integrity?.unverified ?? '—'}</td><td>{s.integrity?.unknown ?? '—'}</td></tr>
      })}</tbody>
    </table></div>
  </details>
}
