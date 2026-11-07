import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AttachmentBatchRead, type AttachmentFile, type LocalAttachment } from '../../apps/web/src/assistant-attachment-read'
import { AssistantAttachmentReadStatus } from '../../apps/web/src/AssistantAttachmentReadStatus'
import '../../apps/web/src/styles.css'
import '../../apps/web/src/assistant.css'

function Preview() {
  const [reading, setReading] = useState(false), [mode, setMode] = useState('slow'), [notice, setNotice] = useState(''), [reads, setReads] = useState(0), [aborts, setAborts] = useState(0)
  const [draft, setDraft] = useState<LocalAttachment[]>([{ name: '已有合成附件.txt', size: 1, data: 'QQ==' }]), modeRef = useRef(mode); modeRef.current = mode
  const model = useRef<AttachmentBatchRead<AttachmentFile>>()
  if (!model.current) model.current = new AttachmentBatchRead({
    busy: setReading, accepted: files => { setDraft(previous => [...previous, ...files]); setNotice('合成批次完整加入草稿，尚未发送。') }, failed: error => setNotice(error instanceof Error ? error.message : '合成失败'),
    read: (file, signal) => new Promise((resolve, reject) => {
      const selected = modeRef.current; setReads(value => value + 1)
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
      const cancel = () => { setAborts(value => value + 1); if (selected === 'late') return; cleanup(); reject(new Error('合成读取中止')) }
      signal.addEventListener('abort', cancel, { once: true })
      if (selected !== 'hang') timer = setTimeout(() => { cleanup(); if (selected === 'failure' && file.name.startsWith('1')) reject(new Error('合成首文件失败，剩余读取应中止')); else resolve('QQ==') }, selected === 'failure' && file.name.startsWith('1') ? 100 : 1500)
    }),
  })
  useEffect(() => () => { model.current?.cancel(false) }, [])
  const start = () => { setNotice(''); void model.current!.start([{ name: '1-合成.txt', size: 1, type: 'text/plain' }, { name: mode === 'metadata' ? '2-不支持.pdf' : '2-合成.txt', size: 1, type: 'text/plain' }]) }
  return <main style={{ padding: 24, maxWidth: 800, margin: 'auto' }}><h1>附件读取 · 纯 mock 手测</h1><p>正式批次模型和取消控件；仅合成元数据/计时器，不读取用户文件、不请求后端、不上传或调用模型。读取 {reads} 次，中止通知 {aborts} 次。</p>
    <label>下次合成场景<select value={mode} disabled={reading} onChange={e => setMode(e.target.value)}>{[['slow', '延迟1.5秒'], ['hang', '挂起，等待取消'], ['failure', '首文件失败'], ['metadata', '不支持的文件，读取前拒绝'], ['late', '忽略取消，结果迟到']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <button className="btn" disabled={reading} onClick={start}>模拟选择两个附件</button>
    <AssistantAttachmentReadStatus reading={reading} cancel={() => { if (model.current!.cancel()) setNotice('已取消本批读取，已有附件保持不变。') }} />
    <p role="status">{notice}</p><h2>本地草稿（仅合成）</h2><ul>{draft.map((file, index) => <li key={index}>{file.name}</li>)}</ul>
    <p>手测：延迟/挂起期间取消，已有文件应保留；再开始新批次，迟到结果不得加入。首文件失败应中止剩余读取，不部分追加。不支持格式应在读取前拒绝。检查360px窄屏，取消按钮须可见。没有发送入口，页面CSP禁止联网。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
