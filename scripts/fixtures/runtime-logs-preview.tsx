import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RuntimeLogs } from '../../apps/web/src/RuntimeLogs'
import '../../apps/web/src/styles.css'

function Preview() {
  const [mode, setMode] = useState('normal'), [english, setEnglish] = useState(false), [visible, setVisible] = useState(true), [revision, setRevision] = useState(0), [reads, setReads] = useState(0)
  const current = useRef(mode); current.current = mode
  const get = useRef(async (_url: string, _signal: AbortSignal) => {
    const chosen = current.current; setReads(value => value + 1)
    if (chosen === 'error') throw new Error('synthetic request failure')
    if (chosen === 'hang') return new Promise(() => {})
    if (chosen === 'slow') await new Promise(resolve => setTimeout(resolve, 1000))
    if (chosen === 'empty') return []
    if (chosen === 'invalid') return [{ id: 'bad' }]
    if (chosen === 'nullable') return [
      { id: 5, ts: 'legacy timestamp', level: null, source: null, message: null },
      { id: 4, ts: '', level: '', source: '', message: '' },
      { id: 3, ts: '', level: 'null', source: 'null', message: 'null' },
      { id: 2, ts: '', level: 'all', source: '', message: '' },
      { id: 1, ts: '', level: 'missing', source: '', message: '' },
    ]
    return Array.from({ length: chosen === 'below' ? 199 : 200 }, (_, i) => ({ id: 300 - i, ts: i === 0 ? '2026-11-07 12:34:56' : '2026-11-07T12:00:00.123Z', level: ['WARN', 'INFO', 'ERROR', 'CUSTOM', ''][i % 5], source: i % 2 ? 'mock-store' : 'mock-poller', message: i === 0 ? '<script>synthetic text only</script>\n第二行，不执行HTML。' : i === 1 ? '很长的合成日志。'.repeat(100) : `synthetic row ${i}, timeout detail` }))
  }).current
  return <main style={{ padding: 24, maxWidth: 1050, margin: 'auto' }}><h1>近期日志 · 纯 mock 手测</h1><p>正式读取模型/查看器，全部为合成记录，不读取后端或真实日志、不调用模型。读取次数 {reads}；筛选/分页不增加读取次数。</p>
    <div className="toolbar"><label>下次合成响应<select value={mode} onChange={e => setMode(e.target.value)}>{[['normal', '200条，上限边界'], ['below', '199条'], ['nullable', 'NULL、空串和字面null'], ['empty', '空快照'], ['error', '读取失败'], ['invalid', '异常响应'], ['hang', '挂起，10秒超时'], ['slow', '延迟1秒，忽略取消']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label>
      <button className="btn" onClick={() => setVisible(value => !value)}>{visible ? '关闭查看器' : '重新打开'}</button>
      <button className="btn" onClick={() => { setMode('empty'); setRevision(value => value + 1) }}>模拟清空成功通知（不执行清理）</button></div>
    {visible && <RuntimeLogs get={get} english={english} reloadToken={revision} />}
    <p>手测：输入“mock-poller timeout”、切换级别、翻页；只筛本次200条。200条提示可能更早，199条不误报截断。读取失败/异常/超时保留上次并标未核实，恢复后重新读。延迟时关闭/重开，旧结果不可污染新查看器；模拟清空只产生合成空快照。检查长消息、HTML文本、中英文及360px横向滚动。后端时间原文不改时区。CSP禁止联网，页面无真实清理或发送入口。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
