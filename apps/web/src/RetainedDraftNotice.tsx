import React from 'react'
import type { RetainedDraft } from './draft-navigation'

/** Detached records only: no save, restore, device lookup or persistent/browser storage. */
export function RetainedDraftNotice({ records, english, onDiscard }: { records: readonly RetainedDraft[]; english: boolean; onDiscard: (id: number) => void }) {
  if (!records.length) return null
  return <section className="write-msg error" aria-label={english ? 'Detached draft records' : '移除设备的草稿记录'}>
    <p role="status">{english ? 'An edited device disappeared from the accepted device list. Read-only draft records are kept in this page memory only; see each capture result below. Refreshing or closing the page loses them. These are not saved configuration or verified device identity. Nothing is restored or saved to a device, including a device with the same ID.' : '正在编辑的设备已不在最新设备清单中。草稿记录仅只读保留在当前页内存，请查看各条留存结果；刷新或关闭页面会丢失。记录不是已保存配置，设备身份未核实；不会恢复或保存到任何设备，包括同 ID 设备。'}</p>
    {records.map(record => <details key={record.id}>
      <summary>{english ? 'Record' : '记录'} {record.id} · {english ? 'Opening device ID' : '打开时设备 ID'} {record.ownerId} · {record.kind === 'device' ? english ? 'Device editor' : '设备编辑' : english ? 'Point editor' : '点位编辑'}</summary>
      <p>{english ? 'Opening context (not identity verification): ' : '打开时上下文（不代表身份核实）：'}{record.snapshot?.context ?? (english ? 'Unavailable' : '无法取得')}</p>
      {record.busy !== false && <p role="note">{english ? 'A save was pending or its state was unknown at removal. This record cannot determine the save result. The original request was not cancelled or retried; verify the outcome separately.' : '移除时保存尚在进行或状态未知。记录不能判定保存结果；原请求未取消或重试，请另行核对。'}</p>}
      {record.snapshot ? <><p>{english ? 'Raw opening values and input text; copy manually if needed. This is not an importable backup.' : '以下为打开时字段及输入原文，可手工记录；不是可导入备份。'}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '20rem', overflow: 'auto' }}>{record.snapshot.text}</pre></> : <p role="alert">{english ? 'Input capture failed. Only the removal notice remains; the original input could not be retained.' : '输入留存失败，仅保留移除提示，无法找回原输入。'}</p>}
      <button type="button" className="btn" onClick={() => onDiscard(record.id)}>{english ? 'Discard this record…' : '丢弃此记录…'}</button>
    </details>)}
  </section>
}
