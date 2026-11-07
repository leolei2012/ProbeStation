import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { RuntimeLogs } from './RuntimeLogs'
import { LogCleanupDialog } from './LogCleanupDialog'
import { logCleanupFlow } from './log-cleanup-flow'
import { ConfigBackupSettings } from './ConfigBackupSettings'
import { AssistantSettings } from './AssistantSettings'
export interface SettingsModalProps {
  initialSection: 'general' | 'ai'; onAISaved: () => void
  t: (key: string) => string; theme: 'light' | 'dark' | 'system'; setTheme: (value: 'light' | 'dark' | 'system') => void
  lang: 'zh' | 'en'; setLang: (value: 'zh' | 'en') => void; onClose: () => void
  api: { get: (url: string) => Promise<any>; post: (url: string, body?: unknown) => Promise<any> }
}
type Theme = SettingsModalProps['theme']
export function SettingsModal({ t, theme, setTheme, lang, setLang, onClose, initialSection, onAISaved, api }: SettingsModalProps) {
  const [section, setSection] = useState<'general' | 'ai' | 'data' | 'about'>(initialSection)
  const [msg, setMsg] = useState('')
  const [retention, setRetention] = useState<number>(2592000)
  const [customRetention, setCustomRetention] = useState('')
  const [showLogs, setShowLogs] = useState(false), [logRevision, setLogRevision] = useState(0)
  const [showLogCleanup, setShowLogCleanup] = useState(false)
  const cleanupState = useSyncExternalStore(logCleanupFlow.subscribe, logCleanupFlow.snapshot, logCleanupFlow.snapshot)
  useEffect(() => { if (['completed', 'uncertain'].includes(cleanupState.phase)) setLogRevision(value => value + 1) }, [cleanupState])
  useEffect(() => { api.get('/api/retention').then((r: any) => setRetention(r.retention_seconds)).catch(() => {}) }, [])
  const retentionPresets: Array<[string, number]> = [
    ['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800], ['30d', 2592000], ['90d', 7776000], [t('retentionForever'), 0],
  ]
  const applyRetention = async (seconds: number) => {
    setRetention(seconds)
    try { await api.post('/api/retention', { retention_seconds: seconds }); setMsg(t('retentionSaved')) } catch { /* ignore */ }
  }
  const saveCustomRetention = async () => {
    const s = Number(customRetention)
    if (!Number.isInteger(s) || s < 0) return
    await applyRetention(s)
  }
  const items = [
    { id: 'general' as const, label: t('appearance'), icon: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a1.5 1.5 0 0 1 0-3h3a6 6 0 0 0 0-12Z' },
    { id: 'ai' as const, label: 'AI 助手', icon: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' },
    { id: 'data' as const, label: t('dataMgmt'), icon: 'M4 6c0-4 16-4 16 0s-16 4-16 0Zm0 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0' },
    { id: 'about' as const, label: t('appInfo'), icon: 'M12 8h.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0' },
  ]
  return <div className="modal-mask">
    <div className="modal settings-modal settings-shell" role="dialog" aria-modal="true" aria-label={t('settingsTitle')}>
      <aside className="settings-nav">
        <div className="settings-nav-heading">{t('settingsTitle')}</div>
        <nav aria-label="设置分类">
          {items.map((item, i) => <div key={item.id}>
            {(i === 0 || i === 2) && <div className="settings-nav-group">{i === 0 ? (lang === 'zh' ? '通用' : 'General') : (lang === 'zh' ? '数据与信息' : 'Data & information')}</div>}
            <button className={'settings-nav-item' + (section === item.id ? ' selected' : '')} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>{item.label}
            </button>
          </div>)}
        </nav>
      </aside>
      <section className="settings-detail">
        <header className="settings-detail-head"><h2>{items.find(i => i.id === section)?.label}</h2><button className="modal-close" data-settings-close aria-label={lang === 'zh' ? '关闭设置' : 'Close settings'} onClick={onClose}>×</button></header>
        <div className="settings-detail-body">
          <div hidden={section !== 'ai'}><AssistantSettings onSaved={onAISaved} /></div>
          {section === 'general' && <>
            <div className="settings-line"><div><strong>{t('themeLabel')}</strong><p>{lang === 'zh' ? '选择界面外观，或跟随系统自动切换。' : 'Choose an appearance or follow your system.'}</p></div><div className="seg">
              {(['light', 'dark', 'system'] as const).map(v => <button key={v} className={theme === v ? 'selected' : ''} onClick={() => setTheme(v)}>{t(v)}</button>)}
            </div></div>
            <div className="settings-line"><div><strong>{t('language')}</strong><p>{lang === 'zh' ? '设置界面显示语言。' : 'Choose your display language.'}</p></div><div className="seg"><button className={lang === 'zh' ? 'selected' : ''} onClick={() => setLang('zh')}>中文</button><button className={lang === 'en' ? 'selected' : ''} onClick={() => setLang('en')}>English</button></div></div>
          </>}
          {section === 'data' && <>
            <ConfigBackupSettings lang={lang} />
            <div className="settings-line"><div><strong>{t('retentionLabel')}</strong><p>{lang === 'zh' ? '设置历史采样数据的保留时长。' : 'Set how long to retain historical samples.'}</p></div><select aria-label={t('retentionLabel')} value={customRetention !== '' || !retentionPresets.some(([, s]) => s === retention) ? 'custom' : String(retention)} onChange={e => {
              if (e.target.value === 'custom') { setCustomRetention(String(retention)); return }
              setCustomRetention(''); void applyRetention(Number(e.target.value))
            }}>{retentionPresets.map(([label, s]) => <option key={s} value={s}>{label}</option>)}<option value="custom">自定义 / Custom</option></select></div>
            {(customRetention !== '' || !retentionPresets.some(([, s]) => s === retention)) && <div className="settings-line"><label htmlFor="settings-retention">{lang === 'zh' ? '自定义时长（秒）' : 'Custom duration (seconds)'}</label><div className="settings-inline"><input id="settings-retention" type="number" min="0" step="1" value={customRetention} onChange={e => setCustomRetention(e.target.value)} /><button className="btn" onClick={saveCustomRetention}>{lang === 'zh' ? '保存' : 'Save'}</button></div></div>}
            <div className="settings-line"><div><strong>{t('runLogs')}</strong><p>{lang === 'zh' ? '查看近期全服务运行日志，或先预览再确认清理；预览后新增日志会保留。' : 'View recent service-wide logs or preview cleanup first; later logs are preserved.'}</p></div><div className="settings-inline"><button type="button" className="btn" aria-expanded={showLogs} onClick={() => setShowLogs(value => !value)}>{lang === 'zh' ? showLogs ? '收起日志' : '查看近期日志' : showLogs ? 'Hide logs' : 'View recent logs'}</button><button type="button" className="btn" onClick={() => setShowLogCleanup(true)}>{lang === 'zh' ? '预览日志清理' : 'Preview log cleanup'}</button></div></div>
            {showLogs && <RuntimeLogs english={lang === 'en'} reloadToken={logRevision} />}
            {showLogCleanup && <LogCleanupDialog english={lang === 'en'} onClose={() => setShowLogCleanup(false)} />}
            {msg && <p className="settings-feedback" role="status">{msg}</p>}
          </>}
          {section === 'about' && <>
            <div className="settings-product"><div className="settings-product-mark">P</div><div><strong>ProbeStation</strong><p>{lang === 'zh' ? '设备观测与测试' : 'Device observation & testing'}</p></div></div>
            <div className="settings-line"><strong>{t('version')}</strong><span className="kv">0.1.0</span></div>
            <div className="settings-line"><strong>{t('arch')}</strong><span className="kv">Cordis · TypeScript</span></div>
            <div className="settings-line"><strong>{t('persistence')}</strong><span className="kv">SQLite + DuckDB</span></div>
          </>}
        </div>
      </section>
    </div>
  </div>
}
