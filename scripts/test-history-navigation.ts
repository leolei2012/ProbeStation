import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { HistoryNavigation } from '../apps/web/src/history-navigation.ts'

const target = { deviceId: 1, view: 'history', registerId: 11, start: '2026-11-06T00:00:00Z', end: '2026-11-06T01:00:00Z', token: 1 }
const navigation = new HistoryNavigation()
assert.ok(navigation.consume(target, 1, [11], true)?.range)
assert.equal(navigation.consume({ ...target }, 1, [11, 12], true), null, 'a refreshed point list must not replay the old navigation and reset user analysis')
assert.equal(navigation.consume(target, 1, [], false), null, 'later configuration loading never reopens an already consumed range')
assert.ok(navigation.consume({ ...target, token: 2 }, 1, [11], true)?.range, 'an explicit repeated click is a new intent, even with identical dates/point')
const loading = new HistoryNavigation()
const first = loading.consume(target, 1, [], false)!
assert.ok(first.range); assert.deepEqual(first.focus, { state: 'waiting', id: 11 })
assert.equal(loading.consume(target, 1, [], false), null, 'loading rerenders do not reset the range repeatedly')
const focused = loading.consume(target, 1, [11, 12], true)!
assert.equal(focused.range, undefined, 'late definitions focus only the point; manually changed time and table/chart mode stay intact')
assert.deepEqual(focused.focus, { state: 'found', id: 11 })
assert.equal(loading.consume(target, 1, [11, 12, 13], true), null)
const manual = new HistoryNavigation()
manual.consume(target, 1, [], false); manual.cancelPending()
assert.equal(manual.consume(target, 1, [11, 12], true), null, 'explicit point choice supersedes deferred focus')
const missing = new HistoryNavigation()
missing.consume(target, 1, [], false)
const absent = missing.consume(target, 1, [12], true)!
assert.equal(absent.range, undefined); assert.deepEqual(absent.focus, { state: 'missing', id: 11 })
assert.equal(missing.consume(target, 1, [11], true), null, 'missing IDs are not silently remapped or retried on later unrelated configuration changes')
assert.deepEqual(missing.consume({ ...target, token: 3 }, 1, [11], true)?.focus, { state: 'found', id: 11 })
const empty = new HistoryNavigation().consume(target, 1, [], true)!
assert.deepEqual(empty.focus, { state: 'missing', id: 11 }, 'a loaded empty table is distinct from definitions still loading')
const cleared = new HistoryNavigation()
cleared.consume(target, 1, [], false); cleared.consume(null, 1, [], false)
assert.equal(cleared.consume(target, 1, [11], true), null, 'clearing a target cancels its pending focus')
for (const other of [{ ...target, view: 'live' }, { ...target, view: 'diagnostics' }, { ...target, deviceId: 2 }, { ...target, start: undefined }, { ...target, end: undefined }]) {
  assert.equal(new HistoryNavigation().consume(other, 1, [11], true), null)
}
for (const bad of [{ ...target, start: 'bad date' }, { ...target, end: target.start }, { ...target, start: target.end, end: target.start }, ...[0, -1, NaN, Infinity, 1.5].map(registerId => ({ ...target, registerId }))]) {
  const gate = new HistoryNavigation()
  assert.deepEqual(gate.consume(bad, 1, [11], true), { invalid: true })
  assert.equal(gate.consume(bad, 1, [11], true), null, 'an invalid event is reported once rather than replayed on refresh')
}
const all = new HistoryNavigation().consume({ ...target, registerId: undefined }, 1, [], true)!
assert.ok(all.range); assert.equal(all.focus, undefined, 'general ranged history links preserve the existing selection')
const legacy = new HistoryNavigation(), noToken = { ...target, token: undefined }
assert.ok(legacy.consume(noToken, 1, [11], true)?.range)
assert.equal(legacy.consume({ ...noToken }, 1, [11, 12], true), null)
const before = JSON.stringify(target)
new HistoryNavigation().consume(Object.freeze(target), 1, Object.freeze([11]), true)
assert.equal(JSON.stringify(target), before)
// Exercise applying the same actions as HistoryView, with simulated manual analysis in between.
const view = { range: 'default', mode: 'table', selected: [12], resets: 0 }, gate = new HistoryNavigation()
const apply = (action: ReturnType<HistoryNavigation['consume']>) => {
  if (action?.range) { view.range = String(action.range.start); view.mode = 'chart'; view.resets++ }
  if (action?.focus) view.selected = action.focus.state === 'found' ? [action.focus.id] : []
}
apply(gate.consume(target, 1, [], false)); view.range = 'manual range'; view.mode = 'table'
apply(gate.consume(target, 1, [11, 12], true))
assert.deepEqual(view, { range: 'manual range', mode: 'table', selected: [11], resets: 1 })
view.selected = [12]; gate.cancelPending(); apply(gate.consume(target, 1, [11, 12], true))
assert.deepEqual(view.selected, [12])
apply(gate.consume({ ...target, token: 99 }, 1, [11, 12], true))
assert.equal(view.resets, 2); assert.deepEqual(view.selected, [11])
const rawTarget = { ...target, valueMode: 'raw' as const }, rawGate = new HistoryNavigation()
assert.equal(rawGate.consume(rawTarget, 1, [], false)!.valueMode, 'raw')
assert.equal(rawGate.consume(rawTarget, 1, [11], true)!.valueMode, undefined, 'late focus never repeats a value-mode change')
assert.equal(rawGate.consume({ ...rawTarget, valueMode: 'physical' }, 1, [11], true)!.valueMode, 'physical', 'explicit mode is part of the intent identity')
assert.equal(new HistoryNavigation().consume(target, 1, [11], true)!.valueMode, undefined, 'old targets preserve the current value mode')
for (const valueMode of ['other', '', null, 0]) assert.deepEqual(new HistoryNavigation().consume({ ...target, valueMode } as any, 1, [11], true), { invalid: true })

// Source-fragment integration: execute only the actual navigation allocations,
// prop wiring and consume/cancel expressions, never mount App or run its I/O.
const sourceFile = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = (name: string) => sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration
function nodes(root: ts.Node, matches: (node: ts.Node) => boolean) { const found: ts.Node[] = []; const visit = (node: ts.Node) => { if (matches(node)) found.push(node); ts.forEachChild(node, visit) }; visit(root); return found }
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const expression = (node: ts.Node, names: string[], values: unknown[]) => new Function(...names, compile('const result = ' + node.getText(sourceFile) + '; return result'))(...values)
const parentComponent = component('DeviceView'), childComponent = component('HistoryView'); assert(parentComponent && childComponent)
function allocation(fn: ts.FunctionDeclaration) {
  const statements = fn.body!.statements.filter(node => node.getText(sourceFile).includes('HistoryNavigation'))
  if (!statements.length) return null
  const declarations = statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  assert.equal(declarations.length, 1, 'review the owner harness when allocation boundaries change')
  const name = declarations[0].name.getText(sourceFile), run = new Function('useRef', 'HistoryNavigation', compile(statements.map(node => node.getText(sourceFile)).join('\n') + '\nreturn ' + name))
  return { name, render(refs: Array<{ current: unknown }>) { let index = 0; return run(() => { const slot = index++; return refs[slot] ?? (refs[slot] = { current: undefined }) }, HistoryNavigation) } }
}
const parentAllocation = allocation(parentComponent), childAllocation = allocation(childComponent)
const historyElement = nodes(parentComponent, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === 'HistoryView')[0] as ts.JsxSelfClosingElement
assert(historyElement)
const ownerProp = historyElement.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'navigation') as ts.JsxAttribute | undefined
const tabElement = nodes(parentComponent, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === 'TabBar')[0] as ts.JsxSelfClosingElement
const tabChange = tabElement.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'onChange') as ts.JsxAttribute
assert(tabChange.initializer && ts.isJsxExpression(tabChange.initializer) && tabChange.initializer.expression)
const consumeCall = nodes(childComponent, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'consume')[0]
const cancelDeclaration = nodes(childComponent, node => ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'cancelNavigation')[0] as ts.VariableDeclaration
assert(consumeCall && cancelDeclaration?.initializer)
function deviceLifetime(deviceId = 1) {
  const refs: Array<{ current: unknown }> = []
  return { leave() {
    const names = ['setTab', ...(parentAllocation ? [parentAllocation.name] : [])], values = [() => {}, ...(parentAllocation ? [parentAllocation.render(refs)] : [])]
    expression((tabChange.initializer as ts.JsxExpression).expression!, names, values)(0)
  }, mount() {
    const parent = parentAllocation?.render(refs)
    const child = childAllocation?.render([])
    const scope = child ?? (ownerProp?.initializer && ts.isJsxExpression(ownerProp.initializer) && ownerProp.initializer.expression ? expression(ownerProp.initializer.expression, [parentAllocation!.name], [parent]) : undefined)
    assert(scope, 'history must receive a navigation owner')
    return {
      consume(next: typeof rawTarget, ready = true, ids = [11, 12]) { return expression(consumeCall, ['navigation', 'target', 'device', 'registers', 'configurationReady'], [scope, next, { id: deviceId }, ids.map(id => ({ id })), ready]) as ReturnType<HistoryNavigation['consume']> },
      cancel() { expression(cancelDeclaration.initializer!, ['navigation', 'setNavigationNotice'], [scope, () => {}])() },
    }
  } }
}
const lifetime = deviceLifetime(), firstHistory = lifetime.mount(), exact = Object.freeze({ ...rawTarget, start: '2026-11-06T00:00:00.123Z', end: '2026-11-06T01:00:00.456Z' })
assert.deepEqual(firstHistory.consume(exact), { range: { start: Date.parse(exact.start), end: Date.parse(exact.end) }, valueMode: 'raw', focus: { state: 'found', id: 11 } })
firstHistory.cancel() // User explicitly chooses point 12 / physical values before changing tabs.
assert.equal(firstHistory.consume(exact), null)
lifetime.leave()
const reopened = lifetime.mount() // HistoryView unmounts on the real tab===2 conditional.
assert.equal(reopened.consume(exact), null, 'switching live→history must not replay the old point/range/value-mode target')
assert.ok(reopened.consume({ ...exact, token: 2 })?.range, 'explicit repeat remains a new intent after remount')
const delayedLifetime = deviceLifetime(), delayedMount = delayedLifetime.mount()
assert.equal(delayedMount.consume(exact, false)!.focus!.state, 'waiting')
assert.deepEqual(delayedLifetime.mount().consume(exact), { focus: { state: 'found', id: 11 } }, 'pending definitions may focus once after remount without replaying time/mode')
const departedLifetime = deviceLifetime(); departedLifetime.mount().consume(exact, false); departedLifetime.leave()
assert.equal(departedLifetime.mount().consume(exact), null, 'leaving history cancels unresolved focus; the old point must not appear later in a different default range')
const canceledLifetime = deviceLifetime(), canceledMount = canceledLifetime.mount(); canceledMount.consume(exact, false); canceledMount.cancel()
assert.equal(canceledLifetime.mount().consume(exact), null, 'manual cancellation survives history tab remount')
const missingLifetime = deviceLifetime(); assert.equal(missingLifetime.mount().consume(exact, true, [])!.focus!.state, 'missing')
assert.equal(missingLifetime.mount().consume(exact), null, 'missing point is not silently retried on remount')
assert.equal(deviceLifetime(2).mount().consume(exact), null, 'another device cannot consume the old target')
assert.ok(deviceLifetime(2).mount().consume({ ...exact, deviceId: 2 })?.range, 'new device lifetime owns a separate intent journal')
console.log('HISTORY NAVIGATION OK: one-shot/late/invalid/legacy intents plus actual parent/child allocations, prop wiring and consume/cancel/tab expressions; remount, manual override, leaving cancels unresolved focus, late definitions, missing ID, explicit repeat, exact time/value-mode and device isolation; no component mount, DOM, service, device or model I/O')
