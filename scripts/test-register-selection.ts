import assert from 'node:assert/strict'
import { selectSourceRegister, type RegisterSelector } from '../packages/core/src/register-selection.ts'
const regs = [
  { id: 1, groupId: 10, alias: 'one', functionCode: 3, startAddress: 0, dataType: 'uint16', slaveId: 1 },
  { id: 2, groupId: 20, alias: 'two', functionCode: 3, startAddress: 0, dataType: 'uint16', slaveId: 2 },
  { id: 3, groupId: 30, alias: 'input', functionCode: 4, startAddress: 0, dataType: 'uint16', slaveId: 2 },
]
const ref: RegisterSelector = { area: 'holding-register', address: 0 }
const selected = (selector: RegisterSelector, input: Parameters<typeof selectSourceRegister>[0] = regs) => {
  const result = selectSourceRegister(input, selector)
  assert.ok('register' in result); return result.register
}
assert.equal(selected({ ...ref, slaveId: 1 }).id, 1)
assert.equal(selected({ ...ref, slaveId: 2 }).id, 2)
assert.equal(selected({ ...ref, registerId: 2 }).slaveId, 2)
assert.equal(selected({ ...ref, registerId: 2, slaveId: 2 }).id, 2)
for (const slaveId of [0, 255]) assert.equal(selected({ ...ref, slaveId }, [{ ...regs[0], slaveId }]).slaveId, slaveId)
assert.equal(selected({ ...ref, area: 'input-register' }).id, 3)
assert.equal(selected(ref, [regs[0]]).id, 1, 'unique legacy references still work')
const ambiguity = selectSourceRegister(regs, ref)
assert.ok('error' in ambiguity); assert.equal(ambiguity.code, 'REGISTER_AMBIGUOUS')
assert.deepEqual(ambiguity.candidates.map(p => [p.register_id, p.slave_id]), [[1, 1], [2, 2]])
assert.deepEqual(JSON.parse(JSON.stringify(ambiguity)).candidates, ambiguity.candidates)
for (const selector of [{ ...ref, slaveId: 3 }, { ...ref, registerId: 999 }, { ...ref, slaveId: 1, registerId: 2 }, { ...ref, address: 1, registerId: 1 }, { ...ref, area: 'coil', registerId: 1 }]) {
  const result = selectSourceRegister(regs, selector)
  assert.ok('error' in result); assert.equal(result.code, 'REGISTER_NOT_FOUND')
}
const duplicates = [...regs, { ...regs[0], id: 4, dataType: 'int16' }]
assert.ok('error' in selectSourceRegister(duplicates, { ...ref, slaveId: 1 }), 'same-source semantic definitions must not be arbitrarily selected')
assert.equal(selected({ ...ref, registerId: 4 }, duplicates).dataType, 'int16')
const unknown = [{ ...regs[0], slaveId: undefined }]
assert.equal(selected({ ...ref, registerId: 1 }, unknown).slaveId, undefined, 'point IDs do not fill unknown configured sources')
assert.ok('error' in selectSourceRegister(unknown, { ...ref, slaveId: 1 }))
for (const slaveId of [-1, 256, 1.5, '1', null, NaN]) {
  const result = selectSourceRegister(regs, { ...ref, slaveId: slaveId as any })
  assert.ok('error' in result); assert.equal(result.code, 'REGISTER_SELECTOR_INVALID')
}
for (const registerId of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
  const result = selectSourceRegister(regs, { ...ref, registerId: registerId as any })
  assert.ok('error' in result); assert.equal(result.code, 'REGISTER_SELECTOR_INVALID')
}
console.log('REGISTER SELECTION OK: explicit source/point identity, consistent combined selectors, structured candidates, same-source semantics, missing/unknown and invalid input without guessing (pure functions)')
