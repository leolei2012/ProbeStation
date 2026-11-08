import React, { forwardRef } from 'react'

export const PointDraftDiscard = forwardRef<HTMLButtonElement, { english?: boolean; label?: string; busy: boolean; onResume: () => void; onDiscard: () => void }>(function PointDraftDiscard({ english = false, label, busy, onResume, onDiscard }, ref) {
  return <section className="point-draft-discard" role="alert" aria-label={label ?? (english ? 'Point draft close confirmation' : '确认关闭点位草稿')}>
    <p>{english ? 'The local draft differs from the opening values. Closing will discard this input. Continue editing, or discard the draft and close. Discarding sends no save or undo request; it does not establish the outcome of an earlier failed save.' : '本地草稿与打开时不同，关闭将丢弃当前输入。可以继续编辑，或放弃草稿并关闭。放弃不会发送保存或撤销请求，也不能据此判断此前失败保存是否已生效。'}</p>
    <div className="toolbar"><button type="button" className="btn primary" ref={ref} disabled={busy} onClick={onResume}>{english ? 'Continue editing' : '继续编辑'}</button><button type="button" className="btn" disabled={busy} onClick={onDiscard}>{english ? 'Discard draft and close' : '放弃草稿并关闭'}</button></div>
  </section>
})
