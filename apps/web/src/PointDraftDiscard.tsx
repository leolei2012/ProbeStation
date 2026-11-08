import React, { forwardRef } from 'react'

export const PointDraftDiscard = forwardRef<HTMLButtonElement, { english?: boolean; label?: string; busy: boolean; onResume: () => void; onDiscard: () => void }>(function PointDraftDiscard({ english = false, label, busy, onResume, onDiscard }, ref) {
  return <section className="point-draft-discard" role="alert" aria-label={label ?? (english ? 'Point draft close confirmation' : '确认关闭点位草稿')}>
    <p>{english ? 'Closing discards local edits. No save or undo is sent; an earlier save may still have taken effect. Escape continues editing.' : '关闭将丢弃本地修改。放弃不发送保存或撤销请求，也不能据此判断此前保存结果。Esc继续编辑。'}</p>
    <div className="toolbar"><button type="button" className="btn primary" ref={ref} disabled={busy} onClick={onResume}>{english ? 'Continue editing' : '继续编辑'}</button><button type="button" className="btn" disabled={busy} onClick={onDiscard}>{english ? 'Discard draft and close' : '放弃草稿并关闭'}</button></div>
  </section>
})
