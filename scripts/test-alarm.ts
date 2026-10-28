import assert from 'node:assert/strict'
import { ConfigStore } from '../packages/config/src/index.ts'
import { alarmMatches } from '../packages/core/src/alarm.ts'
import { apply } from '../packages/rule/src/index.ts'
import { readAlarmValue } from '../apps/web/src/alarm-value.ts'

const now = Date.now(), sample = { rawValue: 253, quality: 'good', timestamp: new Date(now).toISOString() }
assert.equal(readAlarmValue('uint16', [sample], now, 8000, false, false), 253)
assert.equal(readAlarmValue('uint16', [sample], now + 9000, 8000, false, false), null)
assert.equal(readAlarmValue('uint16', [sample], now, 8000, true, false), null)
assert.equal(readAlarmValue('uint16', [sample], now, 8000, false, true), null)
assert.equal(readAlarmValue('uint16', [undefined], now, 8000, false, false), null)
assert.equal(readAlarmValue('uint16', [{ ...sample, quality: 'bad' }], now, 8000, false, false), null)
assert.equal(readAlarmValue('uint16', [{ ...sample, timestampMs: now + 2000 }], now, 8000, false, false), null)
assert.equal(readAlarmValue('uint32', [sample, { ...sample, timestampMs: now - 2000 }], now, 8000, false, false), null)
assert.equal(readAlarmValue('uint32', [{ ...sample, rawValue: 1, batchId: 'B' }, { ...sample, rawValue: 65535, batchId: 'A' }], now, 8000, false, false), null, 'same-millisecond mixed responses never trigger an alarm')
assert.equal(readAlarmValue('uint32', [{ ...sample, rawValue: 1, batchId: 'B' }, { ...sample, rawValue: 0, batchId: 'B' }], now, 8000, false, false), 65536, 'complete response recovers without changing thresholds')

for (const [op, value, expected] of [['>', 101, true], ['>', 100, false], ['>=', 100, true], ['==', 100, true], ['==', 99, false], ['<', 99, true], ['<=', 100, true], ['!=', 99, true]] as const) assert.equal(alarmMatches(value, op, 100), expected)
assert.equal(alarmMatches(NaN, '!=', 100), false)
assert.equal(alarmMatches(null, '>', 0), false)
assert.equal(alarmMatches(9007199254740993n, '>', 9007199254740992), true)
assert.equal(alarmMatches(9007199254740993n, '==', 9007199254740992), false)
assert.equal(alarmMatches(1n, '==', 1.5), false)
assert.equal(alarmMatches(1n, '<', 1.5), true)

const cfg = new ConfigStore({ dbPath: ':memory:' })
const d = cfg.createObject('Alarm test', '', 502, 'master')
const group = cfg.createGroup(d.id, 'Holding', 3, 0, 4)
const reg = cfg.createRegister(group.id, d.id, 'Temperature', 3, 0, 'int16', { factor: 0.1 })
const input = cfg.createRegister(group.id, d.id, 'Input', 4, 0, 'int16')
const wide = cfg.createRegister(group.id, d.id, 'Wide', 3, 2, 'uint32')
const rule = cfg.createRule(reg.id, '>=', 100, 'Too high')
cfg.createRule(input.id, '>', 100, null)
cfg.createRule(wide.id, '>', 65535, null)
let handler: (event: any) => void = () => {}
const events: any[] = []
apply({ config: cfg, on: (_: string, fn: any) => { handler = fn }, emit: (_: string, event: any) => events.push(event), provide: () => {} } as any)
const emit = (rawValue: number, area = 'holding-register', address = 0, quality = 'good') => handler({ objectId: d.id, points: [{ address, rawValue, area, quality, timestamp: new Date().toISOString() }] })
emit(100); emit(120); emit(140)
assert.equal(events.length, 1, 'continuous alarm emits once')
assert.equal(events[0].value, 100, 'compare raw, not factor-scaled')
assert.equal(cfg.listLogs().length, 1)
emit(99); emit(101)
assert.equal(events.length, 2, 'recovery rearms alarm')
emit(150, 'input-register')
assert.equal(events.length, 3, 'areas isolated')
emit(0, 'holding-register', 0, 'bad'); emit(160)
assert.equal(events.length, 3, 'bad quality cannot clear and retrigger')
emit(1, 'holding-register', 2)
assert.equal(events.length, 3, 'partial multiword samples ignored')
handler({ objectId: d.id, points: [2, 3].map(address => ({ address, rawValue: address === 2 ? 1 : 65535, area: 'holding-register', quality: 'good', batchId: address === 2 ? 'A' : 'B' })) })
assert.equal(events.length, 3, 'different responses cannot fabricate a value that triggers the rule')
handler({ objectId: d.id, points: [2, 3].map(address => ({ address, rawValue: address === 2 ? 1 : 0, area: 'holding-register', quality: 'good' })) })
assert.equal(events.length, 4, 'complete uint32 decoded')
handler({ objectId: d.id, points: [2, 3].map(address => ({ address, rawValue: 0, area: 'holding-register', quality: 'good', batchId: address === 2 ? 'A' : 'B' })) })
handler({ objectId: d.id, points: [2, 3].map(address => ({ address, rawValue: address === 2 ? 1 : 0, area: 'holding-register', quality: 'good', batchId: 'C' })) })
assert.equal(events.length, 4, 'mixed responses cannot clear an active alarm and spuriously rearm it')
cfg.updateRule(rule.id, { registerId: reg.id, operator: '>', threshold: 130, message: 'Updated' })
emit(140)
assert.equal(events.length, 5, 'edited active rule reevaluated')
assert.throws(() => cfg.createRule(reg.id, 'unknown', 1, null))
assert.throws(() => cfg.createRule(reg.id, '>', Infinity, null))
assert.throws(() => cfg.createRule(-1, '>', 1, null))
assert.throws(() => cfg.updateRule(rule.id, { registerId: reg.id, operator: '>', threshold: NaN, message: null }))
assert.equal(cfg.listRules().find(r => r.id === rule.id)?.threshold, 130)
cfg.deleteRule(rule.id)
emit(150)
assert.equal(events.length, 5, 'deleted rule no longer evaluated')
cfg.deleteGroup(group.id)
assert.equal(cfg.listRules().length, 0, 'deleting points removes their rules')
;(cfg as any).db.close()

// Independent event-contract cases: no cache may fill partial responses and an
// invalid latest complete response must not replay an older valid one.
let evaluate: (event: any) => void = () => {}
const triggered: any[] = []
const eventRegister = { id: 1, startAddress: 0, dataType: 'uint32', functionCode: 3 }
apply({ config: {
  listRules: () => [{ id: 1, registerId: 1, operator: '>', threshold: 65535 }],
  listRegistersByObject: () => [eventRegister], log: () => {},
}, on: (_: string, fn: any) => { evaluate = fn }, emit: (_: string, event: any) => triggered.push(event), provide: () => {} } as any)
const wordsFor = (batchId: string, high: number, low: number, quality = 'good') => [high, low].map((rawValue, address) => ({ address, rawValue, quality, area: 'holding-register', batchId }))
const evaluatePoints = (points: any[]) => evaluate({ objectId: 1, points })
evaluatePoints([wordsFor('A', 1, 0)[0]])
evaluatePoints([wordsFor('A', 1, 0)[1]])
assert.equal(triggered.length, 0, 'separate events cannot fill missing words, even if their response IDs match')
evaluatePoints([{ ...wordsFor('legacy', 1, 0)[0], batchId: undefined }, wordsFor('B', 1, 0)[1]])
assert.equal(triggered.length, 0, 'legacy words cannot fill an identified response')
evaluatePoints([...wordsFor('C', 0, 0), ...wordsFor('D', 1, 0)])
assert.equal(triggered.length, 1, 'last complete response in event order is selected')
evaluatePoints([...wordsFor('E', 0, 0), ...wordsFor('F', 0, 0, 'bad')])
evaluatePoints(wordsFor('G', 1, 0))
assert.equal(triggered.length, 1, 'bad complete response cannot fall back to an earlier value and falsely rearm an alarm')
evaluatePoints([...wordsFor('H', 0, 0), ...wordsFor('I', 0, 0), wordsFor('I', 0, 0)[0]])
evaluatePoints(wordsFor('J', 1, 0))
assert.equal(triggered.length, 1, 'duplicate address in complete response stays unknown')
evaluatePoints([...wordsFor('K', 1, 0), ...wordsFor('L', 0, 0)])
evaluatePoints(wordsFor('M', 1, 0))
assert.equal(triggered.length, 2, 'a later complete valid recovery can rearm the alarm')
console.log('ALARM TEST OK: operators, raw values, exact bigint comparison, area isolation, multiword samples, quality, deduplication, recovery and rule validation')
