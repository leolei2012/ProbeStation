import React, { useEffect, useId, useRef, useState } from 'react'
import { captureDeviceEditBaseline, type DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize, type GroupEditSnapshot } from '../../../packages/core/src/group-settings-edit'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from './group-settings-save'
import { configurationWriteBlocked } from './configuration-write-outcome'

export interface GroupEditorInput { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number; mode?: string; registers: readonly unknown[] }
export function GroupModal({ t, device, initial, onClose, onSaved, get, put, create }: {
  t: (key: string) => string; device: DeviceEditBaseline; initial: GroupEditorInput | null; onClose: () => void; onSaved: (warnings: readonly string[]) => void
  get: (url: string, signal: AbortSignal) => Promise<unknown>; put: (url: string, body: unknown) => Promise<unknown>; create: (url: string, body: unknown) => Promise<unknown>
}) {
  const [opening] = useState(() => { try { return { device: captureDeviceEditBaseline(device), graph: initial ? captureGroupOpening(initial, device) : null, error: '' } } catch { return { device: null, graph: null, error: '分组或点位配置不完整，请关闭并刷新后重新编辑。' } } })
  const [name, setName] = useState(initial?.name ?? ''), [slaveId, setSlaveId] = useState(String(initial?.slaveId ?? device.slaveId ?? 1))
  const [functionCode, setFunctionCode] = useState(String(initial?.functionCode ?? 3)), [startAddress, setStartAddress] = useState(String(initial?.startAddress ?? 0))
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1)), [active, setActive] = useState(initial ? initial.isActive === 1 : true)
  const [snapshot, setSnapshot] = useState<GroupEditSnapshot | null>(null), [reading, setReading] = useState(!!initial && !opening.error), [readError, setReadError] = useState(opening.error)
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false)
  const lock = useRef(false), title = useId(), english = t('cancel') === 'Cancel', text = (zh: string, en: string) => english ? en : zh
  useEffect(() => {
    if (!opening.graph) return
    const controller = new AbortController(); let current = true
    setSnapshot(null); setReading(true); setReadError(''); setConfirmed(false)
    void readGroupSettings(opening.graph, get, controller.signal).then(value => { if (current) setSnapshot(value) }, e => { if (current) setReadError(e instanceof Error ? e.message : t('operationFailed')) }).finally(() => { if (current) setReading(false) })
    return () => { current = false; controller.abort() }
  }, [attempt])
  const body = { name, slaveId: opening.device?.mode === 'slave' ? opening.device.slaveId : Number(slaveId), functionCode: Number(functionCode), startAddress: Number(startAddress), quantity: Number(quantity), isActive: active ? 1 : 0 }
  let plan: ReturnType<typeof planGroupResize> | null = null, planError = ''
  if (snapshot) { try { plan = planGroupResize(snapshot, parseGroupEditChanges(body, snapshot.group)) } catch { planError = text('请填写有效的分组名称、从站、功能码及整数地址/数量。', 'Enter a valid name, slave, function and integer address/quantity.') } }
  const destructive = !!plan?.removeRegisterIds.length || !!plan?.removeRuleIds.length
  const changed = (update: () => void) => { update(); setConfirmed(false); setError('') }
  const save = async () => {
    if (lock.current || !opening.device || initial && (!snapshot || !plan || reading || destructive && !confirmed)) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (snapshot) { const result = await saveGuardedGroupSettings(snapshot, body, confirmed, put); onSaved(result.warnings) }
      else { const result = await create('/api/monitor_objects/' + opening.device.id + '/groups', body); onSaved(groupCreateWarnings(result)) }
    } catch (e) {
      const rejected = e instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(e.message)
      const blocked = !initial ? configurationWriteBlocked(e, true, english) : null
      setError(blocked ? blocked.message : !initial && !rejected ? text('创建结果待核实，请核对分组及点位，勿重复创建。', 'Creation outcome is unverified. Check the group and points before creating again.') : e instanceof Error ? e.message : t('operationFailed'))
    }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="modal-mask"><form className="modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={title} onSubmit={e => { e.preventDefault(); void save() }} onKeyDown={e => {
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')), first = items[0], last = items[items.length - 1]
    if (!first) { e.preventDefault(); e.currentTarget.focus(); return }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  }}>
    <h3 id={title}>{t(initial ? 'editGroup' : 'newGroup')}</h3>
    {initial && <p className="enum-hint">{text('保存前核对组、点位、告警及设备来源；变化会拒绝保存并保留草稿。数量沿用按定义条数同步的规则；修改地址或功能码不重建已有点位。', 'Saving checks group, points, rules and device source; conflicts keep drafts. Quantity follows definition-count rules. Changing address/function does not rebuild existing points.')}</p>}
    {reading && <p role="status">{text('正在读取点位与告警快照，尚不能保存…', 'Reading points and alarm snapshot; saving is disabled…')}</p>}
    {readError && <div className="write-msg error" role="alert">{readError}{opening.graph && <button type="button" className="btn" disabled={busy || reading} onClick={() => setAttempt(v => v + 1)}>{text('重读快照', 'Retry snapshot')}</button>}</div>}
    <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
      <label>{t('groupName')}<input value={name} required onChange={e => changed(() => setName(e.target.value))} autoFocus /></label>
      <label>{t('slaveId')}<input type="number" min={0} max={247} step={1} required value={opening.device?.mode === 'slave' ? opening.device.slaveId : slaveId} disabled={opening.device?.mode === 'slave'} onChange={e => changed(() => setSlaveId(e.target.value))} /></label>
      <label>{t('functionCode')}<select value={functionCode} onChange={e => changed(() => setFunctionCode(e.target.value))}>{[1, 2, 3, 4].map((fc, i) => <option value={fc} key={fc}>FC0{fc} · {t(['fcReadCoils', 'fcReadDiscrete', 'fcReadHolding', 'fcReadInput'][i])}</option>)}</select></label>
      <label>{t('startAddress')}<input type="number" min={0} max={65535} step={1} required value={startAddress} onChange={e => changed(() => setStartAddress(e.target.value))} /></label>
      <label>{t('quantity')}<input type="number" min={1} max={65536 - Number(startAddress)} step={1} required value={quantity} onChange={e => changed(() => setQuantity(e.target.value))} /></label>
      <label className="checkbox-row"><input type="checkbox" checked={active} onChange={e => changed(() => setActive(e.target.checked))} /><span>{t('enable')}</span></label>
      {planError && <p className="write-msg error" role="alert">{planError}</p>}
      {plan && <section aria-label={text('缩扩容预览', 'Resize preview')}><p>{text('本次将新增 / 删除点位 / 删除告警', 'Add points / Delete points / Delete rules')}: {plan.addAddresses.length} / {plan.removeRegisterIds.length} / {plan.removeRuleIds.length}</p>
        {destructive && <><details><summary>{text('查看全部删除编号', 'Review all deletion IDs')}</summary><pre style={{ maxHeight: '24vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text('点位', 'Points')}: {plan.removeRegisterIds.join(', ')}{'\n'}{text('告警', 'Rules')}: {plan.removeRuleIds.join(', ')}</pre></details><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>{text('已核对本次删除的点位和告警；保存后生效', 'I reviewed the point/rule deletions; they apply on save')}</span></label></>}
      </section>}
    </fieldset>
    {error && <div className="write-msg error" role="alert">{error}</div>}
    <div className="modal-actions"><button className="btn" type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button><button className="btn primary" type="submit" disabled={busy || !opening.device || !!initial && (reading || !snapshot || !plan || destructive && !confirmed)}>{t(busy ? 'working' : 'save')}</button></div>
  </form></div>
}
