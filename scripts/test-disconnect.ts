import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ slave: 18502 })
const cfg = ctx.get('config', false)
const slave = ctx.get('slave', false)
const poller = ctx.get('poller', false)
const store = ctx.get('store', false)

const errors: Array<{ objectId: number; groupId: number; error: string }> = []
const oks: number[] = []
ctx.on('poller/group-error', (e: any) => errors.push(e))
ctx.on('poller/group-ok', (e: any) => oks.push(e.groupId))

// 两台设备：A 启用（addr 0）、B 启动时就是「断开」（addr 1）
const objA = cfg.createObject('A', '127.0.0.1', 18502)
const gA = cfg.createGroup(objA.id, 'gA', 3, 0, 1)
const regA = cfg.createRegister(gA.id, objA.id, 'rA', 3, 0)

const objB = cfg.createObject('B', '127.0.0.1', 18502)
const gB = cfg.createGroup(objB.id, 'gB', 3, 1, 1)
const regB = cfg.createRegister(gB.id, objB.id, 'rB', 3, 1)
cfg.updateObject(objB.id, { isActive: 0 }) // B 启动即断开

slave.setRegister(0, 100)
slave.setRegister(1, 500)
poller.startAll()
await new Promise((r) => setTimeout(r, 800))

console.log('A after start =', store.getLatestByObject(objA.id, 'holding-register')[regA.startAddress]?.rawValue, '(expect 100)')
const bDisconnected = errors.some((e) => e.groupId === gB.id && e.error === 'Disconnected')
const bNotPolled = store.getLatestByObject(objB.id, 'holding-register')[regB.startAddress]?.rawValue === undefined
console.log('B Disconnected event =', bDisconnected, '| B not polled =', bNotPolled)

// A 运行中「断开」
cfg.toggleObject(objA.id)
slave.setRegister(0, 111)
await new Promise((r) => setTimeout(r, 1500))
const aFrozen = store.getLatestByObject(objA.id, 'holding-register')[regA.startAddress]?.rawValue === 100
const aDisconnected = errors.some((e) => e.groupId === gA.id && e.error === 'Disconnected')
console.log('A frozen =', aFrozen, '| A Disconnected event =', aDisconnected)

// A 「重连」
cfg.toggleObject(objA.id)
await new Promise((r) => setTimeout(r, 2000))
const aResumed = store.getLatestByObject(objA.id, 'holding-register')[regA.startAddress]?.rawValue === 111
console.log('A resumed =', aResumed, '(latest =', store.getLatestByObject(objA.id, 'holding-register')[regA.startAddress]?.rawValue + ')')

// B 点「连接」：启动时断开的设备，连接后应开始轮询
cfg.updateObject(objB.id, { isActive: 1 })
await new Promise((r) => setTimeout(r, 2000))
const bPolled = store.getLatestByObject(objB.id, 'holding-register')[regB.startAddress]?.rawValue === 500
console.log('B after connect =', store.getLatestByObject(objB.id, 'holding-register')[regB.startAddress]?.rawValue, '(expect 500) | polled =', bPolled)

poller.stopAll()
const ok = aFrozen && aDisconnected && aResumed && bDisconnected && bNotPolled && bPolled
console.log(ok ? 'DISCONNECT TEST OK' : 'DISCONNECT TEST FAIL')
process.exit(ok ? 0 : 1)
