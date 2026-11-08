import React from 'react'
import type { RetainedDraft } from './draft-navigation'

export function ConfigurationSaveHint({ english, device = false }: { english: boolean; device?: boolean }) {
  return <p className={device ? 'device-field-hint' : 'enum-hint'} role="note">{english ? 'Saving checks opening values/source. Conflicts reject saves and keep drafts. Record changes; close and refresh to edit again. No automatic overwrite. Runtime warnings are separate.' : '保存核对打开时字段及来源；冲突会拒绝保存并保留草稿。请记录修改、关闭刷新后编辑，不自动覆盖；运行警告另行提示。'}</p>
}

export function DetachedEditorNotice({ english }: { english: boolean }) {
  return <p role="alert">{english ? 'Removal observed or requested. Editing and new saves are disabled. Check the outcome and page records before reopening.' : '设备移除或删除已触发，旧编辑器停用编辑及新保存。请核对结果与本页记录后重新打开。'}</p>
}

/** Detached records only: no save, restore, device lookup or persistent/browser storage. */
export function RetainedDraftNotice({ records, english, onDiscard }: { records: readonly RetainedDraft[]; english: boolean; onDiscard: (id: number) => void }) {
  if (!records.length) return null
  return <section className="write-msg error" aria-label={english ? 'Detached draft records' : '移除设备的草稿记录'}>
    <p role="status">{english ? 'Read-only removal records stay in this page memory only; refresh/close loses them. Check capture results and the device list: deletion may be unconfirmed. Records are not saved configuration or verified identity. Nothing is restored or saved to devices, including those with the same ID.' : '移除草稿记录仅在当前页内存只读留存，刷新或关页会丢失。请核对留存结果及设备清单，删除可能未确认。记录不是已保存配置或身份凭据，不会恢复或保存到设备（含同 ID）。'}</p>
    {records.map(record => <details key={record.id}>
      <summary>{english ? 'Record' : '记录'} {record.id} · {english ? 'Opening device ID' : '打开时设备 ID'} {record.ownerId} · {record.kind === 'device' ? english ? 'Device editor' : '设备编辑' : english ? 'Point editor' : '点位编辑'}</summary>
      <p>{english ? 'Opening context (not identity verification): ' : '打开时上下文（不代表身份核实）：'}{record.snapshot?.context ?? (english ? 'Unavailable' : '无法取得')}</p>
      {record.deletion && <p role="note">{english ? 'Captured before deletion, not proof of success. On failure/unknown results, the old editor stays disabled; check configuration before reopening.' : '删除请求前留存，不代表成功。失败或结果待核实，旧编辑器仍停用；请核对配置后重新打开。'}</p>}
      {record.busy !== false && <p role="note">{english ? 'A save was pending or its state was unknown at removal. This record cannot determine the save result. The original request was not cancelled or retried; verify the outcome separately.' : '移除时保存尚在进行或状态未知。记录不能判定保存结果；原请求未取消或重试，请另行核对。'}</p>}
      {record.snapshot ? <><p>{english ? 'Raw opening values and input text. Copy manually; not an importable backup.' : '打开时字段及输入原文，可手工记录；不可作备份导入。'}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '20rem', overflow: 'auto' }}>{record.snapshot.text}</pre></> : <p role="alert">{english ? 'Input capture failed. Only the removal notice remains; the original input could not be retained.' : '输入留存失败，仅保留移除提示，无法找回原输入。'}</p>}
      <button type="button" className="btn" onClick={() => onDiscard(record.id)}>{english ? 'Discard this record…' : '丢弃此记录…'}</button>
    </details>)}
  </section>
}
