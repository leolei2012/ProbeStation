import assert from 'node:assert/strict'
import { physicalValue, displayNumber, curveValue } from '../apps/web/src/physical-value'

const reg = { dataType: 'uint16', factor: 0.1, offset: 0 }
assert.equal(physicalValue(254, reg).value, '25.4')
assert.equal(physicalValue(254, { ...reg, offset: -40 }).value, '-14.6')
assert.equal(physicalValue(-138, { dataType: 'int16' }).value, '-138')
assert.equal(physicalValue(0.5, { ...reg, factor: 13.75 }).value, '6.875')
assert.equal(physicalValue(1, { ...reg, factor: -2, offset: 3 }).value, '1')
assert.equal(physicalValue(NaN, reg).issue, 'invalid')
assert.equal(physicalValue(Number.MAX_VALUE, { ...reg, factor: 2 }).issue, 'invalid')
assert.equal(physicalValue(1, { ...reg, factor: Infinity }).issue, 'invalid')
assert.equal(physicalValue(1, { ...reg, dataType: 'hex16' }).issue, 'raw')
assert.equal(physicalValue(1, { ...reg, dataType: 'bin32' }).issue, 'raw')
const large = 18446744073709551615n
assert.equal(physicalValue(large, { dataType: 'uint64', factor: 2, offset: -1 }).value, '36893488147419103229')
assert.equal(physicalValue(large, { dataType: 'uint64', factor: 0.1 }).issue, 'precision')
assert.equal(physicalValue(254n, { dataType: 'uint64', factor: 0.1 }).value, '25.4')
console.log('PHYSICAL VALUE OK: scale, offset, defaults, floating-point formatting, invalid samples and exact 64-bit transformations')

assert.equal(displayNumber(25.3, { decimalPlaces: 2 }), '25.30')
assert.equal(displayNumber(-0.001, { decimalPlaces: 2 }), '0.00')
assert.equal(displayNumber(2.9, { decimalPlaces: 0 }), '3')
assert.equal(displayNumber(large, { decimalPlaces: 2 }), '18446744073709551615.00')
assert.equal(physicalValue(253, { ...reg, decimalPlaces: 2 }).value, '25.30')
assert.equal(curveValue(253, { ...reg, decimalPlaces: 0 }, 'physical'), 253 * 0.1)
assert.equal(curveValue(253, reg, 'raw'), 253)
assert.equal(curveValue(null, reg, 'physical'), null)
assert.equal(curveValue(Number.MAX_VALUE, { ...reg, factor: 2 }, 'physical'), null)
console.log('DISPLAY MODES OK: decimal formatting and full precision curves')
