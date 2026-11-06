import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Fastify from 'fastify'
import { DATA_TYPES, registerWidth } from '../packages/core/src/codec.ts'
import { diagnosePointTable, diagnoseDevicePoints, PointTableInputError } from '../packages/core/src/point-diagnostics.ts'
import { diagnosePointsCli } from './diagnose-points.ts'
import { registerPointDiagnostics } from '../packages/api/src/point-diagnostics.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { parseConfigBackup } from '../packages/config/src/backup.ts'
import { apply as applyImporter } from '../packages/importer/src/index.ts'

const point = (id = 1, startAddress = 0, dataType = 'uint32', extra: any = {}) => ({ id, groupId: 1, objectId: 1, functionCode: 3, startAddress, dataType, alias: null, factor: 1, offset: 0, ...extra })
const graph = (registers = [point()], extra: any = {}) => ({ devices: [{ id: 1, mode: 'master', slaveId: 1 }], groups: [{ id: 1, objectId: 1, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 4 }], registers, ...extra })
const has = (input: unknown, code: string, severity?: string) => assert.ok(diagnosePointTable(input).issues.some(i => i.code === code && (!severity || i.severity === severity)), code)
const normal = graph([point(), point(2, 1, 'int16'), point(3, 2, 'uint16'), point(4, 3, 'int16', { quantity: 999999 })])
const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
const original = JSON.stringify(normal)
const clean = diagnosePointTable(freeze(normal))
assert.equal(clean.summary.errors, 0); assert.equal(clean.summary.warnings, 0); assert.equal(clean.summary.coveredPlaceholders, 1)
assert.equal(JSON.stringify(normal), original, 'diagnostics must not normalize or repair caller-owned input')
for (const dataType of DATA_TYPES) {
  const width = registerWidth(dataType), startAddress = 65536 - width
  const result = diagnosePointTable(graph([point(1, startAddress, dataType)], { groups: [{ id: 1, objectId: 1, slaveId: 1, functionCode: 3, startAddress, quantity: width }] }))
  assert.equal(result.summary.errors, 0, dataType + ' at the exact address boundary')
}
has(graph([point(1, 65535, 'uint32')]), 'REGISTER_ADDRESS_OVERFLOW', 'error')
has(graph([point(1, 1, 'float64-LE')]), 'REGISTER_WIDTH_OUTSIDE_GROUP', 'error')
has(graph([point(1, -1)]), 'INVALID_REGISTER_ADDRESS', 'error')
has(graph([point(1, 4, 'uint16')]), 'REGISTER_START_OUTSIDE_GROUP', 'error')
has(graph([point(1, 0, 'unknown32')]), 'UNSUPPORTED_DATA_TYPE', 'error')
has(graph([point(1, 0, 'uint32_LE')]), 'LEGACY_TYPE_SPELLING', 'warning')
assert.equal(diagnosePointTable(graph([point(1, 0, 'uint32_LE')])).summary.errors, 0)
has(graph([point(1, 0, 'UINT32')]), 'UNSUPPORTED_DATA_TYPE', 'error')
for (const quantity of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) has(graph([point(1, 0, 'uint16', { quantity })]), 'INVALID_QUANTITY_METADATA', 'error')
has(graph([point(1, 0, 'uint16', { objectId: 2 })]), 'REGISTER_DEVICE_MISMATCH', 'error')
has(graph([point(1, 0, 'uint16', { functionCode: 4 })]), 'REGISTER_FUNCTION_MISMATCH', 'error')
has(graph([point(1, 0, 'uint16', { groupId: 99 })]), 'REGISTER_GROUP_MISSING', 'error')
has(graph([point(), point()]), 'DUPLICATE_ID', 'error')
has(graph([point(1, 0, 'uint16'), point(2, 0, 'uint16', { alias: 'other name' })]), 'DUPLICATE_DEFINITION', 'warning')
assert.equal(diagnosePointTable(graph([point(1, 0, 'int16'), point(2, 0, 'int16')])).summary.coveredPlaceholders, 0, 'duplicate start addresses are not trailing placeholders')
const alternatives = graph([point(1, 0, 'uint16'), point(2, 0, 'uint16', { factor: 2 })])
has(alternatives, 'ALTERNATE_DEFINITION', 'warning'); assert.equal(diagnosePointTable(alternatives).summary.errors, 0)
has(graph([point(), point(2, 1, 'int16', { alias: 'intentional low word' })]), 'COVERED_DEFINITION', 'warning')
const coveredWide = graph([point(), point(2, 1, 'float64')])
has(coveredWide, 'COVERED_WIDTH_OUTSIDE_GROUP', 'warning'); assert.equal(diagnosePointTable(coveredWide).summary.errors, 0)
for (const quantity of [0, -1, 1.5, Infinity, 65537]) has(graph([], { groups: [{ ...graph().groups[0], quantity }] }), 'INVALID_GROUP_RANGE', 'error')
has(graph([], { groups: [{ ...graph().groups[0], objectId: 99 }] }), 'GROUP_DEVICE_MISSING', 'error')
has(graph([], { groups: [{ ...graph().groups[0], functionCode: 5 }] }), 'INVALID_GROUP_FUNCTION', 'error')
for (const slaveId of [0, 248, '1']) has(graph([], { groups: [{ ...graph().groups[0], slaveId }] }), 'INVALID_GROUP_REQUEST', 'error')
has(graph([], { groups: [{ ...graph().groups[0], slaveId: undefined }] }), 'DEFAULT_SLAVE_ID', 'warning')
assert.equal(diagnosePointTable(graph([], { groups: [{ ...graph().groups[0], slaveId: undefined }] })).summary.errors, 0)
// Whole groups may exceed one request's PDU limit; the poller already splits them.
for (const [functionCode, quantity] of [[3, 126], [4, 126], [1, 2001], [2, 2001]]) {
  const input = graph([point(1, quantity - 2, 'uint32', { functionCode })], { groups: [{ ...graph().groups[0], functionCode, quantity }] })
  assert.equal(diagnosePointTable(input).summary.errors, 0)
}
const overlap = graph([point(), point(2, 1, 'uint32', { groupId: 2 })], { groups: [graph().groups[0], { ...graph().groups[0], id: 2, startAddress: 1 }] })
has(overlap, 'OVERLAPPING_GROUP_VALUES', 'warning'); assert.equal(diagnosePointTable(overlap).summary.errors, 0)
const separate = structuredClone(overlap); separate.groups[1].slaveId = 2
assert.equal(diagnosePointTable(separate).summary.warnings, 0, 'different source ranges are not physical conflicts')
const sameAddress = structuredClone(separate); sameAddress.registers[1].startAddress = 0; sameAddress.groups[1].startAddress = 0
const differentSources = diagnosePointTable(sameAddress)
assert.equal(differentSources.summary.errors, 0); assert.deepEqual(differentSources.issues.map(i => i.code), ['IMPORT_MATCH_AMBIGUOUS'])
const otherArea = structuredClone(sameAddress); otherArea.groups[1].functionCode = 4; otherArea.registers[1].functionCode = 4
assert.equal(diagnosePointTable(otherArea).summary.warnings, 0)
const local = graph([], { devices: [{ id: 1, mode: 'slave', slaveId: 7 }], groups: [{ ...graph().groups[0], slaveId: 0 }] })
assert.equal(diagnosePointTable(local).summary.errors, 0, 'local slave groups use the device source, not ignored group IDs')
local.devices[0].slaveId = 0; has(local, 'INVALID_LOCAL_SLAVE', 'error')
assert.equal(diagnosePointTable({ devices: [], groups: [], registers: [] }).summary.errors, 0)
const many = diagnosePointTable(graph(Array.from({ length: 10000 }, (_, i) => point(i + 1, 0, 'uint16'))))
assert.equal(many.summary.registers, 10000); assert.equal(many.complete, true)
assert.equal(many.issues.find(i => i.code === 'DUPLICATE_DEFINITION')!.registerIds!.length, 10000, 'duplicate clusters retain every reference instead of silently truncating or generating quadratic pairs')
for (const input of [null, {}, { devices: [], groups: null, registers: [] }, { devices: [null], groups: [], registers: [] }]) assert.throws(() => diagnosePointTable(input), PointTableInputError)

// Existing backups and import semantics are preserved, using only an in-memory config DB.
const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  const d = cfg.createObject('mock point diagnostics', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'range', 3, 0, 2)
  cfg.createRegister(g.id, d.id, 'wide', 3, 1, 'uint32', { quantity: 123 })
  const backup = cfg.exportBackup(); parseConfigBackup(backup)
  has(backup, 'REGISTER_WIDTH_OUTSIDE_GROUP', 'error')
  const before = JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listGroups(d.id), registers: cfg.listRegistersByObject(d.id) })
  const report = diagnoseDevicePoints(cfg, d.id)
  assert.equal(report.ok, false); assert.equal(JSON.stringify({ devices: cfg.listObjects(), groups: cfg.listGroups(d.id), registers: cfg.listRegistersByObject(d.id) }), before)
  const legacy = structuredClone(backup); for (const r of legacy.registers) delete (r as any).quantity
  assert.deepEqual(diagnosePointTable(legacy), diagnosePointTable(backup), 'legacy metadata defaults do not redefine dtype width')
  let importer: any
  applyImporter({ config: cfg, provide: (_name: string, service: any) => { importer = service } } as any)
  const importedDevice = cfg.createObject('mock import', 'mock.invalid', 502)
  importer.import(importedDevice.id, 'synthetic.mbp', Buffer.from('[Window1]\nFunction=03\nAddress=40001\nQuantity=1\nAlias=holding\n[Window2]\nFunction=04\nAddress=30001\nQuantity=1\nAlias=input\n'))
  assert.equal(diagnoseDevicePoints(cfg, importedDevice.id).summary.errors, 0, 'fixed importer keeps each synthetic window with its own group')
} finally { (cfg as any).db.close() }

// A read-only route, including failures; never start an HTTP server.
const app = Fastify(), calls: string[] = []
const port = { getObject: (i: number) => { calls.push('get'); return i === 1 ? graph().devices[0] : undefined }, listGroups: () => { calls.push('groups'); return normal.groups }, listRegistersByObject: () => { calls.push('registers'); return normal.registers } }
registerPointDiagnostics(app, port)
try {
  const r = await app.inject('/api/monitor_objects/1/point-diagnostics')
  assert.equal(r.statusCode, 200); assert.equal(r.json().summary.coveredPlaceholders, 1)
  const before = calls.length
  for (const invalid of ['0', '-1', 'abc', '1.5', '9007199254740992']) assert.equal((await app.inject('/api/monitor_objects/' + invalid + '/point-diagnostics')).statusCode, 400)
  assert.equal(calls.length, before)
  assert.equal((await app.inject('/api/monitor_objects/99/point-diagnostics')).statusCode, 404)
  port.listRegistersByObject = () => [point(1, 1, 'float64')]
  const finding = await app.inject('/api/monitor_objects/1/point-diagnostics')
  assert.equal(finding.statusCode, 200); assert.equal(finding.json().ok, false, 'findings are a successful report, not an HTTP failure')
  port.listGroups = () => { throw Object.assign(new Error('mock-private-error'), { statusCode: 418 }) }
  const failed = await app.inject('/api/monitor_objects/1/point-diagnostics')
  assert.equal(failed.statusCode, 500); assert.ok(!failed.body.includes('mock-private-error'))
} finally { await app.close() }

// Real offline CLI subprocesses in a fresh temporary directory; no default DB or network entrypoint.
const dir = mkdtempSync(join(tmpdir(), 'probestation-point-diagnostics-')), file = join(dir, 'points.json')
writeFileSync(file, JSON.stringify(normal)); const contents = readFileSync(file, 'utf8')
const root = dirname(dirname(fileURLToPath(import.meta.url))), cli = fileURLToPath(import.meta.resolve('tsx/cli'))
const run = (...args: string[]) => spawnSync(process.execPath, [cli, join(root, 'scripts/diagnose-points.ts'), ...args], { cwd: dir, encoding: 'utf8' })
let result = run('--json', file); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary.errors, 0)
assert.equal(readFileSync(file, 'utf8'), contents)
writeFileSync(file, JSON.stringify(graph([point(1, 1, 'float64')]))); result = run('--json', file)
assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false)
writeFileSync(file, '{invalid'); assert.equal(run(file).status, 2)
let reads = 0; const fakeRead = () => { reads++; return JSON.stringify(alternatives) }
assert.equal(diagnosePointsCli(['--help'], fakeRead).exitCode, 0); assert.equal(reads, 0)
assert.equal(diagnosePointsCli(['config.db'], fakeRead).exitCode, 2); assert.equal(reads, 0)
assert.equal(diagnosePointsCli(['fake.json'], fakeRead).exitCode, 0, 'warnings alone are nonblocking')
assert.equal(diagnosePointsCli(['fake.json'], () => JSON.stringify({ ...normal, format: 'probestation-config', version: 2 })).exitCode, 2)
console.log('POINT DIAGNOSTICS OK: dtype/address/group boundaries, covered placeholders/legacy quantity, duplicate/source/area/overlap/import rules, immutable JSON, memory backup/import, read-only API failures and real isolated CLI smoke')
