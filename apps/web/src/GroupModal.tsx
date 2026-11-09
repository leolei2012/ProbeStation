import React, { useEffect, useId, useRef, useState } from 'react'
import { captureDeviceEditBaseline, deviceEditMatches, type DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize, type GroupEditSnapshot } from '../../../packages/core/src/group-settings-edit'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from './group-settings-save'
import { configurationWriteBlocked } from './configuration-write-outcome'
import type { DraftRegistration } from './draft-navigation'
import { bindBeforeUnload } from './before-unload'
import { DetachedEditorNotice } from './RetainedDraftNotice'

export interface GroupEditorInput { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number; mode?: string; registers: readonly unknown[] }
export function GroupModal({ t, device, initial, onClose, onSaved, get, put, create, draftScope, creationReady = true }: {
  t: (key: string) => string; device: DeviceEditBaseline; initial: GroupEditorInput | null; onClose: () => void; onSaved: (warnings: readonly string[]) => void
  get: (url: string, signal: AbortSignal) => Promise<unknown>; put: (url: string, body: unknown) => Promise<unknown>; create: (url: string, body: unknown) => Promise<unknown>
  draftScope?: DraftRegistration; creationReady?: boolean
}) {
  const [opening] = useState(() => { try { return { device: captureDeviceEditBaseline(device), graph: initial ? captureGroupOpening(initial, device) : null, error: '' } } catch { return { device: null, graph: null, error: '分组或点位配置不完整，请关闭并刷新后重新编辑。' } } })
  const creationRevoked = useRef(false)
  if (!initial && opening.device) { try { if (!deviceEditMatches(captureDeviceEditBaseline(device), opening.device)) creationRevoked.current = true } catch { creationRevoked.current = true } }
  const creationBlocked = !initial && (!creationReady || creationRevoked.current)
  const [name, setName] = useState(initial?.name ?? ''), [slaveId, setSlaveId] = useState(String(initial?.slaveId ?? device.slaveId ?? 1))
  const [functionCode, setFunctionCode] = useState(String(initial?.functionCode ?? 3)), [startAddress, setStartAddress] = useState(String(initial?.startAddress ?? 0))
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1)), [active, setActive] = useState(initial ? initial.isActive === 1 : true)
  const [snapshot, setSnapshot] = useState<GroupEditSnapshot | null>(null), [reading, setReading] = useState(!!initial && !opening.error), [readError, setReadError] = useState(opening.error)
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false)
  const lock = useRef(false), title = useId(), english = t('cancel') === 'Cancel', text = (zh: string, en: string) => english ? en : zh
  const fields = { name, slaveId, functionCode, startAddress, quantity, active }, [originalFields] = useState(() => JSON.stringify(fields)), dirty = JSON.stringify(fields) !== originalFields
  const alive = useRef(true), detached = useRef(draftScope?.removalPending?.() ?? false), [, notifyDetached] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const navigationState = useRef(() => ({ dirty: false, busy: false }))
  navigationState.current = () => ({ dirty: !detached.current && dirty, busy: lock.current })
  const unloadRisk = navigationState.current().dirty || lock.current
  useEffect(() => bindBeforeUnload(window, unloadRisk, () => { const state = navigationState.current(); return state.dirty || state.busy }), [unloadRisk])
  const captureDraft = useRef(() => ({ context: '', text: '' }))
  captureDraft.current = () => { detached.current = true; notifyDetached(true); setReading(false); return { context: `${opening.device?.id ?? device.id} / ${initial?.id ?? 'new'} / ${name}`, text: JSON.stringify({ device: opening.device, groupId: initial?.id ?? null, opening: JSON.parse(originalFields), fields }, null, 2) } }
  useEffect(() => draftScope?.register('group', () => navigationState.current(), () => captureDraft.current()), [draftScope])
  const requestClose = () => {
    if (lock.current) return
    if (!detached.current && dirty) { try { if (!window.confirm(text('关闭将丢弃本页分组草稿，不会保存或撤销；此前保存结果仍须单独核实。确定放弃并关闭？', 'Discard this page’s group draft and close? No save or undo is sent; earlier save outcomes remain unverified.'))) return } catch { return } }
    onClose()
  }
  useEffect(() => {
    if (!opening.graph || detached.current) return
    const controller = new AbortController(); let current = true
    setSnapshot(null); setReading(true); setReadError(''); setConfirmed(false)
    void readGroupSettings(opening.graph, get, controller.signal).then(value => { if (current && !detached.current) setSnapshot(value) }, e => { if (current && !detached.current) setReadError(e instanceof Error ? e.message : t('operationFailed')) }).finally(() => { if (current && !detached.current) setReading(false) })
    return () => { current = false; controller.abort() }
  }, [attempt])
  const body = { name, slaveId: opening.device?.mode === 'slave' ? opening.device.slaveId : Number(slaveId), functionCode: Number(functionCode), startAddress: Number(startAddress), quantity: Number(quantity), isActive: active ? 1 : 0 }
  let plan: ReturnType<typeof planGroupResize> | null = null, planError = ''
  if (snapshot) { try { plan = planGroupResize(snapshot, parseGroupEditChanges(body, snapshot.group)) } catch { planError = text('请填写有效的分组名称、从站、功能码及整数地址/数量。', 'Enter a valid name, slave, function and integer address/quantity.') } }
  const destructive = !!plan?.removeRegisterIds.length || !!plan?.removeRuleIds.length
  const changed = (update: () => void) => { update(); setConfirmed(false); setError('') }
  const save = async () => {
    if (draftScope?.removalPending?.()) { detached.current = true; notifyDetached(true); return }
    if (detached.current || lock.current || creationBlocked || !opening.device || initial && (!snapshot || !plan || reading || destructive && !confirmed)) return
    lock.current = true; setBusy(true); setError('')
    try {
      const warnings = snapshot ? (await saveGuardedGroupSettings(snapshot, body, confirmed, put)).warnings : groupCreateWarnings(await create('/api/monitor_objects/' + opening.device.id + '/groups', body))
      if (alive.current && !detached.current && !draftScope?.removalPending?.()) onSaved(warnings)
    } catch (e) {
      if (!alive.current) return
      const rejected = e instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(e.message)
      const blocked = !initial ? configurationWriteBlocked(e, true, english) : null
      setError(blocked ? blocked.message : !initial && !rejected ? text('创建结果待核实，请核对分组及点位，勿重复创建。', 'Creation outcome is unverified. Check the group and points before creating again.') : e instanceof Error ? e.message : t('operationFailed'))
    }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="modal-mask"><form className="modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={title} onSubmit={e => { e.preventDefault(); void save() }} onKeyDown={e => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); requestClose(); return }
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')), first = items[0], last = items[items.length - 1]
    if (!first) { e.preventDefault(); e.currentTarget.focus(); return }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  }}>
    <h3 id={title}>{t(initial ? 'editGroup' : 'newGroup')}</h3>
    <p className="enum-hint">{text('草稿仅在当前页内存中，刷新或关页会丢失；离开前请保存或手工记录。', 'Drafts stay in this page memory only; refresh or close loses them. Save or copy them before leaving.')}</p>
    {detached.current && <DetachedEditorNotice english={english} />}
    {creationBlocked && <p className="write-msg error" role="status">{creationRevoked.current ? text('目标设备定义变化或无法核对；新建草稿保留，请记录输入后关闭重开。', 'Target device definitions changed or cannot be checked. Creation draft kept; copy it before closing and reopening.') : text('设备或点表读取中或未核实；后续新建提交已停用，草稿保留，请重读核对。', 'Device or point definitions loading or unverified. Further creation submissions disabled; draft kept. Re-read and check.')}</p>}
    {initial && <p className="enum-hint">{text('保存前核对组、点位、告警及设备来源；变化会拒绝保存并保留草稿。数量沿用按定义条数同步的规则；修改地址或功能码不重建已有点位。', 'Saving checks group, points, rules and device source; conflicts keep drafts. Quantity follows definition-count rules. Changing address/function does not rebuild existing points.')}</p>}
    {reading && <p role="status">{text('正在读取点位与告警快照，尚不能保存…', 'Reading points and alarm snapshot; saving is disabled…')}</p>}
    {readError && <div className="write-msg error" role="alert">{readError}{opening.graph && <button type="button" className="btn" disabled={busy || reading || detached.current} onClick={() => { if (!detached.current) setAttempt(v => v + 1) }}>{text('重读快照', 'Retry snapshot')}</button>}</div>}
    <fieldset disabled={busy || detached.current} style={{ border: 0, margin: 0, padding: 0 }}>
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
    <div className="modal-actions"><button className="btn" type="button" disabled={busy} onClick={requestClose}>{t('cancel')}</button><button className="btn primary" type="submit" disabled={busy || detached.current || creationBlocked || !opening.device || !!initial && (reading || !snapshot || !plan || destructive && !confirmed)}>{t(busy ? 'working' : 'save')}</button></div>
  </form></div>
}
