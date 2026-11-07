import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RetentionSummary } from '../../apps/web/src/RetentionSummary'
import { deviceRetentionPolicy } from '../../packages/core/src/retention-policy'
import '../../apps/web/src/styles.css'

function Preview() {
  const [scope, setScope] = useState('1'), [global, setGlobal] = useState(600), [scenario, setScenario] = useState('short'), [english, setEnglish] = useState(false)
  const objectId = scope === 'all' ? null : Number(scope)
  const overrides: Record<string, number | null> = { short: 60, seconds: 61, forever: 0, inherit: null, long: 90061, invalid: -1 }
  const retention = scenario === 'loading' ? undefined : { retention_seconds: global, ...(scenario === 'legacy' ? {} : { policy: deviceRetentionPolicy(global, scenario === 'stale' ? 2 : objectId ?? 1, [{ id: scenario === 'stale' ? 2 : objectId ?? 1, dataRetainSeconds: overrides[scenario] ?? null }]) }) }
  return <main style={{ padding: 24, maxWidth: 900, margin: 'auto' }}><h1>保留策略 · 纯 mock 手测</h1>
    <p>正式只读显示组件；仅合成配置，不请求后端、不打开数据库、不修改策略或清理任何数据。</p>
    <div className="toolbar"><label>范围<select value={scope} onChange={e => setScope(e.target.value)}><option value="all">全局</option><option value="1">合成设备1</option></select></label>
      <label>全局默认<select value={global} onChange={e => setGlobal(Number(e.target.value))}><option value="600">600秒</option><option value="0">永久</option><option value="2592000">30天</option></select></label>
      <label>合成场景<select value={scenario} onChange={e => setScenario(e.target.value)}>{[['short', '独立60秒'], ['seconds', '独立61秒'], ['forever', '设备永久'], ['inherit', '跟随全局'], ['long', '1天1小时1分1秒'], ['legacy', '旧后端仅全局'], ['invalid', '无效旧配置'], ['stale', '另一设备旧响应'], ['loading', '未读取']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label></div>
    <section className="db-section"><h2>保留策略</h2><RetentionSummary retention={retention} objectId={objectId} english={english} /></section>
    <p>核对：设备独立永久不被全局600秒覆盖，跟随全局时0=永久；60/61秒不会变为0天。旧后端/另一设备响应/非法值应标未核实，全局范围仅标默认并说明可覆盖。检查英文及360px窄屏。页面没有保存或清理按钮，CSP禁止联网。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
