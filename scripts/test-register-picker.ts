import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RegisterSelectModal, type PickerGroup } from '../apps/web/src/RegisterPicker.tsx'
import { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources } from '../apps/web/src/register-picker.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import * as picker from '../apps/web/src/register-picker.ts'

// Static render/pure data and local hook callbacks only. No app/bootstrap, browser storage, servers or hardware.
const groups: PickerGroup[] = [1, 2].map(slaveId => ({ id: slaveId, name: '同名分组', slaveId, registers: [{ id: slaveId * 11, alias: '温度', functionCode: 3, startAddress: 0, dataType: 'uint16' }] }))
const t = (key: string) => ({ pickerSource: '从站', colAddr: '地址', selectRegisters: '选择点位' }[key] ?? key)
const markup = renderToStaticMarkup(createElement(RegisterSelectModal, { t, groups, initial: new Set(), onClose() {}, onApply() {} }))
assert.match(markup.replace(/<[^>]*>/g, ''), /从站 2/, 'same-name same-address choices must show their configured source')
assert.match(markup, /#11/); assert.match(markup, /#22/)
const fixtures: PickerGroup[] = [...groups, { id: 3, name: '未知来源', registers: [{ id: 33, alias: '状态', startAddress: 4, functionCode: 4, dataType: 'uint16' }] }, { id: 4, name: '空组', slaveId: 9, registers: [] }]
fixtures[1] = { ...fixtures[1], registers: [...fixtures[1].registers, { id: 220, alias: '电流', startAddress: 16, functionCode: 3, dataType: 'float32' }] }
const before = JSON.stringify(fixtures)
const ids = (filtered: PickerGroup[]) => filtered.flatMap(g => g.registers.map(r => r.id))
assert.deepEqual(pickerSources(fixtures), ['1', '2', '?'])
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '2')), [22, 220])
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '?')), [33])
assert.deepEqual(ids(filterPickerGroups(fixtures, '温度 slave:2')), [22])
assert.deepEqual(ids(filterPickerGroups(fixtures, '温度 slave:02')), [22])
assert.deepEqual(ids(filterPickerGroups([{ ...groups[0], registers: [{ ...groups[0].registers[0], alias: '#温度' }] }], '#温度')), [11], 'ordinary names beginning with # remain searchable')
assert.deepEqual(ids(filterPickerGroups(fixtures, 'id:22')), [22])
assert.deepEqual(ids(filterPickerGroups(fixtures, '#22')), [22])
assert.deepEqual(ids(filterPickerGroups(fixtures, 'id:2')), [])
assert.deepEqual(ids(filterPickerGroups(fixtures, '0x0000')), [11, 22])
assert.deepEqual(ids(filterPickerGroups(fixtures, '0X0010')), [220])
assert.deepEqual(ids(filterPickerGroups(fixtures, ' float32 ')), [220])
assert.deepEqual(ids(filterPickerGroups(fixtures, '同名分组 电流')), [220])
assert.deepEqual(ids(filterPickerGroups(fixtures, 'id:bad')), [])
assert.deepEqual(ids(filterPickerGroups(fixtures, 'not found')), [])
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '', 7)), [11, 22, 220, 33])
assert.deepEqual(pickerSources(fixtures, 7), ['7'])
assert.equal(pickerSource(groups[1], 7), 7, 'local slave mode must display the device source rather than unused group metadata')
assert.equal(pickerSource(groups[1], NaN), null, 'invalid explicit device source never falls back to a different group source')
assert.equal(pickerSource({ ...groups[0], slaveId: undefined }), null)
const selected = new Set([33]), visible = filterPickerGroups(fixtures, '', '2')
assert.deepEqual([...addVisiblePickerPoints(selected, visible, 2)], [33, 22])
assert.deepEqual([...addVisiblePickerPoints(selected, visible)], [33, 22, 220])
assert.deepEqual([...addVisiblePickerPoints(selected, visible, 1)], [33])
assert.deepEqual([...selected], [33]); assert.equal(JSON.stringify(fixtures), before)
assert.deepEqual(ids(filterPickerGroups(fixtures, '')), [11, 22, 220, 33], 'resetting filters restores all choices without mutating draft selection')
let calls = 0
const render = (groups: PickerGroup[], extra: any = {}) => renderToStaticMarkup(createElement(RegisterSelectModal, { t: key => ({ pickerSource: '从站', pickerSourceUnknown: '来源未知', pickerAllSources: '全部从站', noMatchingPoints: '没有匹配的点位' }[key] ?? key), groups, initial: new Set(), onClose() { calls++ }, onApply() { calls++ }, ...extra }))
const local = render(fixtures, { deviceSlaveId: 7 })
assert.match(local.replace(/<[^>]*>/g, ''), /从站 7/); assert.doesNotMatch(local, /从站 2|来源未知/)
assert.match(render(fixtures), /来源未知/)
assert.match(render([]), /没有匹配的点位/)
assert.match(render(fixtures, { max: 1, initial: new Set([11]) }), /disabled=""/)
assert.equal(calls, 0, 'rendering never implicitly applies changes or contacts a device')
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '', undefined, new Set([11, 22]))), [11, 22])
assert.deepEqual(ids(filterPickerGroups(fixtures, '温度', '2', undefined, new Set([11, 22]))), [22])
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '', 7, new Set([33]))), [33])
assert.deepEqual(ids(filterPickerGroups(fixtures, '', '', undefined, new Set())), [])
assert.equal(JSON.stringify(fixtures), before)
{
  const env = { ...picker, document: { activeElement: { focus() {} } } }
  const initial = new Set([11, 22]); let applied: Set<number> | null = null, applyCalls = 0
  const props = { t: (key: string) => ({ cancel: 'Cancel', save: 'Save' }[key] ?? key), groups: fixtures, initial, max: 2, onClose() {}, onApply(ids: Set<number>) { applied = ids; applyCalls++ } }
  const driver = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
  try {
    driver.one('select').props.onChange({ target: { value: '2' } }); driver.render()
    driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: '电流' } }); driver.render()
    assert.equal(driver.one('input', p => p.type === 'checkbox').props.disabled, true, 'matching replacement cannot be selected while two hidden choices occupy the limit')
    assert.match(renderToStaticMarkup(driver.tree), /1 matching/)
    driver.one('button', p => p['aria-pressed'] === false).props.onClick(); driver.render()
    assert.equal(driver.one('input', p => p.type !== 'checkbox').props.value, '', 'review exposes all selected points, not the old search intersection')
    assert.equal(driver.one('select').props.value, '')
    const rows = driver.one('div', p => p.className === 'reg-list').props.children[0]
    assert.equal(rows.length, 2, 'review contains both same-address slaves without other points')
    assert.match(renderToStaticMarkup(driver.tree), /2 matching/)
    assert.equal(driver.one('button', p => p['aria-pressed'] === true).props.children, 'Review selected')
    driver.one('input', p => p.type === 'checkbox' && p.checked).props.onChange(); driver.render()
    assert.equal(driver.one('div', p => p.className === 'reg-list').props.children[0].length, 1)
    driver.one('button', p => p['aria-pressed'] === true).props.onClick(); driver.render()
    const list = driver.one('div', p => p.className === 'reg-list').props.children[0]
    const current = list.flatMap((g: any) => g.props.children[1]).find((label: any) => label.key === '220')
    current.props.children[0].props.onChange(); driver.render()
    assert.equal(applyCalls, 0, 'reviewing and replacing selections does not apply implicitly')
    driver.one('button', p => p.children === 'Save').props.onClick()
    assert.deepEqual([...(applied ?? [])], [22, 220]); assert.equal(applyCalls, 1); assert.deepEqual([...initial], [11, 22])
  } finally { driver.dispose() }
  const empty = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, { ...props, max: undefined, initial: new Set(), t: (key: string) => key === 'cancel' ? '取消' : key })
  try {
    empty.one('button', p => p['aria-pressed'] === false).props.onClick(); empty.render()
    assert.equal(empty.one('button', p => p['aria-pressed'] === true).props.children, '查看全部已选')
    assert.match(renderToStaticMarkup(empty.tree), /noMatchingPoints/); assert.match(renderToStaticMarkup(empty.tree), /0 匹配/)
    empty.one('button', p => p.children === 'pickerClearFilters').props.onClick(); empty.render()
    assert.equal(empty.one('button', p => p['aria-pressed'] === false).props.disabled, false)
    assert.match(renderToStaticMarkup(empty.tree), /4 匹配/)
    empty.one('button', p => p.children === '取消').props.onClick(); assert.equal(applyCalls, 1, 'closing does not apply the empty review')
  } finally { empty.dispose() }
  assert.match(render(fixtures), /aria-pressed="false"/)
  console.log('REGISTER PICKER REVIEW OK: hidden capped choices, source/search reset, same-address sources, explicit deselect/replace/apply, empty bilingual review/reset/cancel and immutable initial draft; mock hooks only.')
}
{
  const env = { ...picker, document: { activeElement: { focus() {} } } }
  const initial = new Set([11]); let applies = 0, closes = 0
  const original = structuredClone(groups), props = { t: (key: string) => ({ cancel: 'Cancel', save: 'Save' }[key] ?? key), groups: original, initial, max: 1, onApply() { applies++ }, onClose() { closes++ } }
  const driver = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
  try {
    driver.one('button', p => p['aria-pressed'] === false).props.onClick(); driver.render()
    const oldSave = driver.one('button', p => p.children === 'Save').props.onClick
    const changed = structuredClone(original); changed[0].slaveId = 2
    driver.render({ ...props, groups: changed })
    assert.equal(driver.one('button', p => p.children === 'Save').props.disabled, true, 'same ID from a different source must invalidate the open draft')
    assert.doesNotMatch(renderToStaticMarkup(driver.tree), /type="checkbox"/, 'old IDs are not checked against newly sourced options')
    oldSave(); driver.one('button', p => p.children === 'Save').props.onClick(); assert.equal(applies, 0, 'both current and retained old callbacks reject the changed source')
    assert.match(renderToStaticMarkup(driver.tree), /configuration or source changed/i)
    driver.render(props); assert.equal(driver.one('button', p => p.children === 'Save').props.disabled, true, 'restoring the old definition does not reactivate an invalid draft')
    driver.one('button', p => p.children === 'Cancel').props.onClick(); assert.equal(closes, 1); assert.deepEqual([...initial], [11])
  } finally { driver.dispose() }
  console.log('REGISTER PICKER CONTEXT OK: changed same-ID source blocks current/old saves and stays invalid after restoration; cancel does not apply, synthetic only.')
}
console.log('REGISTER PICKER OK: explicit source/point identity, exact source and ID filters, padded hex/multi-term search, unknown/local-slave provenance, capped visible selection preserving hidden choices and SSR states; no DOM automation or hardware')
{
  const env = { ...picker, document: { activeElement: { focus() {} } } }
  const signature = picker.pickerContext(fixtures), clone = structuredClone(fixtures)
  clone.reverse(); clone.forEach(group => group.registers.reverse())
  assert.equal(picker.pickerContext(clone), signature); assert.equal(JSON.stringify(fixtures), before)
  assert.equal(picker.pickerContext([{ ...groups[0], slaveId: 9 }], 7), picker.pickerContext([groups[0]], 7), 'unused group slave metadata cannot change local-device source identity')
  for (const english of [false, true]) for (const change of ['slave', 'local', 'address', 'area', 'type', 'alias', 'group', 'removed', 'added', 'max']) {
    const initial = new Set([11]), options = structuredClone(groups); let applies = 0
    const props = { t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, groups: options, initial, max: 2, deviceSlaveId: change === 'local' ? 7 : undefined, onClose() {}, onApply() { applies++ } }
    const driver = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
    try {
      driver.one('button', p => p['aria-pressed'] === false).props.onClick(); driver.render()
      const next = structuredClone(options), point = next[0].registers[0]
      if (change === 'slave') next[0].slaveId = 3
      if (change === 'address') point.startAddress++
      if (change === 'area') point.functionCode = 4
      if (change === 'type') point.dataType = 'uint32'
      if (change === 'alias') point.alias = 'changed'
      if (change === 'group') next[0].id = 99
      if (change === 'removed') next[0].registers = []
      if (change === 'added') next[0].registers.push({ ...point, id: 999 })
      driver.render({ ...props, groups: next, max: change === 'max' ? 1 : 2, deviceSlaveId: change === 'local' ? 8 : undefined })
      assert.equal(driver.one('button', p => p.children === 'save').props.disabled, true, change)
      assert.match(renderToStaticMarkup(driver.tree), english ? /Configuration or source changed/ : /配置或来源已变化/)
      driver.one('button', p => p.children === 'save').props.onClick(); assert.equal(applies, 0)
    } finally { driver.dispose() }
  }
  for (const close of ['cancel', 'cross', 'escape']) {
    const initial = new Set([11, 22]); let applies = 0, closes = 0
    const props = { t: (key: string) => key, groups: fixtures, initial, max: 2, onApply() { applies++ }, onClose() { closes++ } }
    const driver = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
    try {
      driver.one('button', p => p['aria-pressed'] === false).props.onClick(); driver.render()
      driver.one('select').props.onChange({ target: { value: '2' } }); driver.render()
      driver.one('input', p => p.type !== 'checkbox').props.onChange({ target: { value: 'id:22' } }); driver.render()
      assert.match(renderToStaticMarkup(driver.tree), /1 匹配/)
      driver.one('input', p => p.type === 'checkbox').props.onChange(); driver.render()
      const reordered = structuredClone(fixtures).reverse(); reordered.forEach(group => group.registers.reverse())
      driver.render({ ...props, groups: reordered }); assert.equal(driver.one('button', p => p.children === 'save').props.disabled, false)
      if (close === 'cancel') driver.one('button', p => p.children === 'cancel').props.onClick()
      if (close === 'cross') driver.one('button', p => p.className === 'modal-close').props.onClick()
      if (close === 'escape') {
        let prevented = 0
        const event = { key: 'Escape', nativeEvent: { isComposing: true }, preventDefault() { prevented++ }, stopPropagation() {} }
        driver.one('div', p => p.role === 'dialog').props.onKeyDown(event); assert.equal(closes, 0)
        driver.one('div', p => p.role === 'dialog').props.onKeyDown({ ...event, nativeEvent: { isComposing: false } }); assert.equal(prevented, 1)
      }
      assert.equal(closes, 1); assert.equal(applies, 0); assert.deepEqual([...initial], [11, 22])
    } finally { driver.dispose() }
    const reopened = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
    try { assert.match(renderToStaticMarkup(reopened.tree), /2 \/ 4/); assert.equal(reopened.one('button', p => p['aria-pressed'] === false).props.disabled, false) } finally { reopened.dispose() }
  }
  console.log('REGISTER PICKER COMPOSITION OK: 20 bilingual context-change cases, equivalent reorder and 3 edited-draft cancel/reopen paths with source/search/limit; no real browser.')
}
{
  const env = { ...picker, document: { activeElement: { focus() {} } } }
  for (const english of [false, true]) {
    const pageGroups = structuredClone(groups), backendGroups = structuredClone(groups)
    let applied: number[] = []
    const props = { t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, groups: pageGroups, initial: new Set([11]), onClose() {}, onApply(ids: Set<number>) { applied = [...ids] } }
    const driver = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', env, props)
    try {
      backendGroups[0].slaveId = 2; driver.render(props)
      assert.equal(driver.one('button', p => p.children === 'save').props.disabled, false, 'unreceived backend changes cannot be detected from unchanged page options')
      driver.one('button', p => p.children === 'save').props.onClick(); assert.deepEqual(applied, [11])
      assert.equal(pageGroups[0].slaveId, 1); assert.equal(backendGroups[0].slaveId, 2)
      const html = renderToStaticMarkup(driver.tree)
      assert.match(html, english ? /does not lock the backend version/ : /不锁定后台版本/)
      assert.match(html, english ? /can change again after refresh/ : /刷新后后台仍可能变化/)
      const description = driver.one('div', p => p.role === 'dialog').props['aria-describedby'].split(' ')
      assert(description.includes(driver.one('p', p => p.id?.endsWith('-context')).props.id), 'the limitation is part of the dialog description')
    } finally { driver.dispose() }
  }
  console.log('REGISTER PICKER UNSEEN LIMIT: unchanged page options still permit local ID selection after unseen backend edits; explicit bilingual limitation, not backend protection.')
}
