import React from 'react'
export function AssistantAttachmentReadStatus({ reading, cancel }: { reading: boolean; cancel: () => void }) {
  return reading ? <div className="ai-attachment-reading"><small role="status">正在本地读取附件，尚未发送…</small><button className="btn" type="button" onClick={cancel}>取消读取</button></div> : null
}
