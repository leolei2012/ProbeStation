import assert from 'node:assert/strict'
import { apply as applyPoller } from '../packages/poller/src/index.ts'
import { apply as applyRules } from '../packages/rule/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { withMockRecordingIntervals } from './fixtures/recording-config.ts'

for (const fc of [1, 2, 3, 4]) for (const dataType of fc <= 2 ? ['uint16'] : ['uint32', 'uint32-LE', 'uint64', 'uint64-LE']) {
  const wide = dataType.includes('64'), threshold = fc <= 2 ? 0 : 65535
  const low = encodeRegister(dataType, fc <= 2 ? 0 : wide ? 5n : 5), high = encodeRegister(dataType, fc <= 2 ? 1 : wide ? 65536n : 65536)
  const groups = [1, 2].map(slaveId => ({ id: slaveId, objectId: 1, slaveId, functionCode: fc, startAddress: 0, quantity: high.length }))
  const registers = groups.map(g => ({ id: g.id, objectId: 1, groupId: g.id, functionCode: fc, startAddress: 0, dataType }))
  let poller: any, evaluate: (event: any) => void = () => {}
  const events: any[] = [], alarms: any[] = [], requests: number[] = []
  const read = async (_address: number, _quantity: number, slaveId: number) => { requests.push(slaveId); const raw = slaveId === 1 ? low : high; return fc <= 2 ? raw.map(Boolean) : raw }
  const driver = { isConnected: () => true, connect: async () => {}, disconnect: async () => {}, readHoldingRegisters: read, readInputRegisters: read, readCoils: read, readDiscreteInputs: read }
  const device = { id: 1, mode: 'master', slaveId: 1, transport: 'tcp', ip: 'mock.invalid', port: 1502, isActive: 1, pollIntervalMs: 0 }
  const context: any = {
    config: withMockRecordingIntervals({
      getObject: () => device, updateObject: () => {},
      getGroup: (id: number) => groups.find(g => g.id === id), listGroups: () => groups,
      listRegistersByObject: () => registers,
      listRules: () => registers.map(r => ({ id: r.id, registerId: r.id, operator: '>', threshold })), log: () => {},
    }),
    on: (name: string, handler: any) => { if (name === 'poller/result') evaluate = handler },
    provide: (name: string, service: any) => { if (name === 'poller') poller = service },
    emit: (name: string, event: any) => {
      if (name === 'poller/result') { const wire = JSON.parse(JSON.stringify(event)); events.push(wire); evaluate(wire) }
      if (name === 'rule/trigger') alarms.push(event)
    },
    store: { write: () => {}, flush: async () => {} },
    modbus: { createDriver: () => driver },
  }
  applyRules(context)
  applyPoller(context, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
  await poller.pollOnce({ id: 1, host: 'mock.invalid', port: 1502, groups })
  assert.deepEqual(alarms.map(a => a.ruleId), [2], `${dataType} FC${fc}: slave 2 must not trigger slave 1's rule at the same address`)
  assert.deepEqual(requests, [1, 2], 'source metadata must describe the original requests without extra reads')
  assert.deepEqual(events[0].points.map((p: any) => p.slaveId), [...low.map(() => 1), ...high.map(() => 2)])
  assert.equal(alarms[0].slaveId, 2, 'alarm provenance must describe the actual response')
  poller.groupsByDevice.set(1, groups)
  await poller.pollNextGroup(device)
  await poller.pollNextGroup(device)
  assert.ok(events[1].points.every((p: any) => p.slaveId === 1))
  assert.ok(events[2].points.every((p: any) => p.slaveId === 2))
  assert.equal(alarms.length, 1, 'round-robin slave 1 must not clear and replay slave 2 alarm')

  let sequence = 0
  const points = (raw: number[], slaveId?: number) => raw.map((rawValue, address) => ({ objectId: 1, area: events[0].points[0].area, address, rawValue, quality: 'good', timestamp: new Date().toISOString(), batchId: 'manual-' + sequence, ...(slaveId !== undefined ? { slaveId } : {}) }))
  const send = (raw: number[], slaveId?: number) => { sequence++; evaluate({ objectId: 1, points: points(raw, slaveId) }) }
  send(low, 1); send(high, 2)
  assert.equal(alarms.length, 1, 'a different slave must not recover the target alarm')
  send(high)
  assert.equal(alarms.length, 1, 'unidentified legacy values in a multi-slave device must not be assigned to any slave')
  if (high.length > 1) {
    sequence++
    evaluate({ objectId: 1, points: points(high).map((p, i) => ({ ...p, slaveId: i === 0 ? 1 : 2 })) })
    assert.equal(alarms.length, 1, 'same batch ID cannot join words from different slaves')
    sequence++
    evaluate({ objectId: 1, points: points(high).map((p, i) => i === 0 ? { ...p, slaveId: 2 } : p) })
    assert.equal(alarms.length, 1, 'legacy words cannot fill an explicitly identified partial response')
  }
  send(low, 2); send(high, 2)
  assert.equal(alarms.length, 2, 'only the target slave can clear and retrigger its alarm')
  groups[1].slaveId = 3
  send(high, 3)
  assert.equal(alarms.length, 3, 'changed source must not inherit the prior slave alarm signature')
  assert.equal(alarms.at(-1).slaveId, 3)
}
console.log('SLAVE SOURCE OK: FC01/02/03/04, pollOnce/round-robin actual source IDs, 32/64-bit BE/LE, false trigger/recovery prevention, legacy/partial rejection and source changes (mock drivers only)')
