import assert from 'node:assert/strict'
import { configurationWriteBlocked } from '../apps/web/src/configuration-write-outcome.ts'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from '../apps/web/src/group-settings-save.ts'

const app = Fastify(), notifications: number[][] = []
let cfg!: ConfigStore, objectId = 0, failNotification = false
cfg = new ConfigStore({ dbPath: ':memory:' }, scope => { if (scope === 'group' || scope === 'register') { notifications.push(cfg.listGroups(objectId).map(group => group.isActive)); if (failNotification) throw new Error('synthetic notification failure') } })
const device = cfg.createObject('synthetic groups', 'mock.invalid', 502); objectId = device.id
const parse = (name: string, path: string) => ts.createSourceFile(name, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const apiSource = parse('api.ts', '../packages/api/src/index.ts')
let registration: ts.CallExpression | undefined
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/monitor_objects/:id/groups') registration = node; ts.forEachChild(node, visit) }; visit(apiSource)
assert(registration)
// Execute only the actual group POST registration/body. No API bootstrap, poller or drivers.
new Function('fastify', 'cfg', ts.transpileModule(registration.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app, cfg)
const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/monitor_objects/' + objectId + '/groups', payload: body as any })
try {
  // Drive the actual new-group form and pass its actual create body through the actual HTTP handler.
  const ui = parse('GroupModal.tsx', '../apps/web/src/GroupModal.tsx'), declaration = ui.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'GroupModal')!
  const cells: any[] = [], deps: any[] = [], receivedWarnings: unknown[][] = []; let cursor = 0, effects: Array<() => void> = [], tree: any, saved = 0, unexpected = 0, sent: any, pending: ReturnType<typeof post> | undefined
  const useState = (init: any) => { const index = cursor++; if (!(index in cells)) cells[index] = typeof init === 'function' ? init() : init; return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] }
  const useRef = (init: any) => useState(() => ({ current: init }))[0]
  const useEffect = (fn: () => void, values: unknown[]) => { const index = cursor++; if (!deps[index] || values.some((value, i) => value !== deps[index][i])) effects.push(fn); deps[index] = values }
  const env = { React, useState, useRef, useEffect, useId: () => useState('mock-group-title')[0], captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }
  const component = new Function(...Object.keys(env), ts.transpileModule('return (' + declaration.getText(ui).replace(/^export /, '') + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
  const props = { t: (key: string) => key, device, initial: null, onClose() { unexpected++ }, onSaved(warnings: unknown[]) { receivedWarnings.push([...warnings]); saved++ }, async get() { unexpected++; throw new Error('new group must not read an edit snapshot') }, async put() { unexpected++; throw new Error('new group must not update another group') }, async create(url: string, body: unknown) { assert.equal(url, '/api/monitor_objects/' + objectId + '/groups'); sent = body; pending = post(body); const response = await pending; if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body); return response.json() } }
  const all = (node: any): any[] => Array.isArray(node) ? node.flatMap(all) : React.isValidElement(node) ? [node, ...all((node.props as any).children)] : []
  const render = () => { cursor = 0; effects = []; tree = component(props); for (const effect of effects) effect() }
  const input = (predicate: (props: any) => boolean) => { const node = all(tree).find(node => node.type === 'input' && predicate(node.props)); assert(node); return node }
  render(); input(p => !p.type).props.onChange({ target: { value: 'paused form group' } }); render()
  input(p => p.type === 'number' && p.min === 1).props.onChange({ target: { value: '2' } }); render()
  input(p => p.type === 'number' && p.max === 247).props.onChange({ target: { value: '13' } }); render()
  assert.equal(input(p => p.type === 'checkbox').props.checked, true)
  input(p => p.type === 'checkbox').props.onChange({ target: { checked: false } }); render()
  all(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert(pending); const response = await pending; await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.isActive, 0); assert.equal(response.statusCode, 200); assert.equal(saved, 1); assert.equal(unexpected, 0)
  assert.deepEqual(receivedWarnings, [[]])
  const paused = response.json(); assert.equal(paused.isActive, 0, 'unchecked Enable in the actual form must create a paused group')
  assert.equal(paused.slaveId, 13); assert.equal(paused.quantity, 2); assert.equal(cfg.getGroup(paused.id)!.isActive, 0)
  assert(notifications.length > 0); assert(notifications.every(values => values.every(value => value === 0)), 'all creation notifications must observe paused state, including the first INSERT')
  assert.equal(cfg.listGroups(objectId).filter(group => group.isActive).length, 0, 'existing active-group scheduling predicate excludes the new paused group')
  assert.deepEqual(cfg.listRegisters(paused.id).map(point => [point.startAddress, point.functionCode, point.dataType]), [[0, 3, 'int16'], [1, 3, 'int16']])

  // Known committed creation with a failed notification must reach the UI as a warning, not a save failure.
  failNotification = true; all(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const warned = await pending!; await new Promise(resolve => setTimeout(resolve, 0)); render(); failNotification = false
  assert.equal(warned.statusCode, 200); assert.equal(saved, 2); assert.equal(receivedWarnings[1].length, 1); assert.match(String(receivedWarnings[1][0]), /已创建.*勿重复/)
  const originalCreate = cfg.createGroupWithRegisters.bind(cfg)
  try {
    for (const statusCode of [500, 400]) {
      cfg.createGroupWithRegisters = () => { throw Object.assign(new Error('synthetic rejected create'), { statusCode }) }
      all(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal((await pending!).statusCode, statusCode)
      await new Promise(resolve => setTimeout(resolve, 0)); render(); assert.equal(saved, 2)
      const message = all(tree).find(node => node.props.role === 'alert')?.props.children
      assert.match(String(message), statusCode === 500 ? /创建结果待核实.*勿重复/ : /HTTP 400/)
    }
  } finally { cfg.createGroupWithRegisters = originalCreate }

  const legacy = await post({ name: 'legacy omitted state' }); assert.equal(legacy.statusCode, 200); assert.equal(legacy.json().isActive, 1)
  const enabled = await post({ name: 'explicit enabled', isActive: 1 }); assert.equal(enabled.statusCode, 200); assert.equal(enabled.json().isActive, 1)
  const disabled = await post({ name: 'explicit paused', functionCode: 4, startAddress: 10, quantity: 2, mode: 'read', slaveId: 11, isActive: 0 })
  assert.equal(disabled.statusCode, 200); assert.deepEqual([disabled.json().isActive, disabled.json().slaveId, disabled.json().functionCode], [0, 11, 4])
  assert.equal(cfg.createGroup(objectId, 'old positional call', 3, 5, 1, 'read', 2).isActive, 1)
  assert.equal((cfg.createGroup as any)(objectId, 'old ignored numeric extra', 3, 6, 1, 'read', 2, 0).isActive, 1, 'an old extra numeric argument must not become an activation switch')
  assert.equal(cfg.createGroup(objectId, 'explicit named option', 3, 7, 1, 'read', 2, { isActive: 0 }).isActive, 0)
  const graph = () => JSON.stringify({ groups: cfg.listGroups(objectId), points: cfg.listRegistersByObject(objectId) }), before = graph(), events = notifications.length
  for (const isActive of [null, false, true, '0', '1', -1, 2, 0.5, {}, []]) {
    const rejected = await post({ name: 'must not create', isActive }); assert.equal(rejected.statusCode, 400); assert.equal(graph(), before); assert.equal(notifications.length, events)
  }
  for (const isActive of [null, false, '0', -1, 2, 0.5, NaN, Infinity]) {
    assert.throws(() => cfg.createGroup(objectId, 'must not insert', 3, 0, 1, 'read', 1, { isActive: isActive as number }), error => (error as any)?.statusCode === 400)
    assert.equal(graph(), before); assert.equal(notifications.length, events)
  }
  console.log('GROUP CREATE ACTIVE OK: actual new-group UI checkbox→actual POST→memory ConfigStore, state persisted before every notification, no active scheduling candidate, unchanged registers/slave/FC, explicit 0/1, legacy omission/positional defaults and invalid-input no-mutation; no DOM automation, real data, poller, sockets or hardware')
} finally { await app.close(); (cfg as any).db.close() }
