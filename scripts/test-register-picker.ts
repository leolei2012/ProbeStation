import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RegisterSelectModal, type PickerGroup } from '../apps/web/src/RegisterPicker.tsx'
import { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources } from '../apps/web/src/register-picker.ts'

// Static render/pure data only. No app/bootstrap, browser storage, servers or hardware.
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
console.log('REGISTER PICKER OK: explicit source/point identity, exact source and ID filters, padded hex/multi-term search, unknown/local-slave provenance, capped visible selection preserving hidden choices and SSR states; no DOM automation or hardware')
