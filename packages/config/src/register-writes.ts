import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { DATA_TYPES, decodeRegister, encodeRegister, registerWidth, baseType } from '../../core/src/codec.ts'
import { parseRegisterWriteValue } from '../../core/src/register-write-value.ts'
import { registerWriteSource, writeConflict, type GuardedWritePlan, type GuardedWriteResult, type GuardedWriteState } from '../../core/src/guarded-register-write.ts'

export function installRegisterWriteSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS register_write_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision TEXT NOT NULL);
    INSERT OR IGNORE INTO register_write_revision VALUES(1, lower(hex(randomblob(32))));
    CREATE TABLE IF NOT EXISTS register_write_operations(id TEXT PRIMARY KEY, channel TEXT NOT NULL, state TEXT NOT NULL, plan TEXT NOT NULL, message TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS register_write_channel ON register_write_operations(channel,state);`)
  // Database triggers include other SQLite connections and bulk/legacy import paths. Rolled-back edits do not advance it.
  for (const table of ['monitor_objects', 'register_groups', 'registers']) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS write_revision_${table}_${event} AFTER ${event} ON ${table}
      BEGIN UPDATE register_write_revision SET revision=lower(hex(randomblob(32))) WHERE singleton=1; END`)
  }
}

/** Persistent one-use operations. No network call/await is permitted in the final SQLite critical section. */
export class RegisterWrites {
  constructor(private database: () => DatabaseSync, private scope: () => string,
    private graph: (id: number) => { device: any; group: any; register: any; registers: any[] }, private failedRollback: (error: unknown) => void) {}
  private transaction<T>(action: (db: DatabaseSync) => T): T {
    const db = this.database()
    if (db.isTransaction) throw writeConflict('配置正在变更，请稍后重新准备。')
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(db); db.exec('COMMIT'); return result }
    catch (error) {
      try { db.exec('ROLLBACK') } catch (rollback) { this.failedRollback(new AggregateError([error, rollback], '写入计划事务回滚失败')) }
      throw error
    }
  }
  private revision(db: DatabaseSync) {
    const row = db.prepare('SELECT revision FROM register_write_revision WHERE singleton=1').get()
    if (!row || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)) throw writeConflict('配置代际不可用。')
    return row.revision
  }
  private row(db: DatabaseSync, id: string): GuardedWriteResult {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw writeConflict('写入计划不存在。')
    const row = db.prepare('SELECT * FROM register_write_operations WHERE id=?').get(id)
    if (!row) throw writeConflict('写入计划不存在。')
    return { version: 1, id, state: row.state as GuardedWriteState, plan: JSON.parse(String(row.plan)), message: String(row.message) }
  }
  get(id: string) {
    const db = this.database(), result = this.row(db, id)
    // A previous process/workspace lifetime cannot establish whether its sending operation reached the device.
    if (result.state === 'sending' && result.plan.scope !== this.scope()) {
      db.prepare("UPDATE register_write_operations SET state='unknown', message='上次运行在确认结果前结束；请现场核实，不能自动重发。' WHERE id=? AND state='sending'").run(id)
      return this.row(db, id)
    }
    return result
  }
  prepare(id: number, value: unknown, expected: unknown): GuardedWriteResult {
    return this.transaction(db => {
      const { device, group, register: r, registers } = this.graph(id)
      if (!device || !group || !r || group.objectId !== device.id || r.objectId !== device.id || r.groupId !== group.id || group.functionCode !== r.functionCode) throw writeConflict('点位、分组与设备关系无效。')
      const source = registerWriteSource(device, group, r)
      // Canonical projection, plus strict shape, prevents clients dropping source fields.
      if (!expected || JSON.stringify(expected) !== JSON.stringify(source)) throw writeConflict()
      if (device.mode !== 'master' || !['tcp', 'rtu'].includes(device.transport) || r.functionCode !== 3) throw writeConflict('当前支持主站保持寄存器 FC06/FC16 写入；该点位不支持。')
      if (!Number.isInteger(group.slaveId) || group.slaveId < 1 || group.slaveId > 247) throw writeConflict('从站地址必须为 1–247，不使用广播写入。')
      if (device.transport === 'tcp' && (!net.isIP(device.ip) || !Number.isInteger(device.port) || device.port < 1 || device.port > 65535)) throw writeConflict('条件写入需要明确的 IP 地址和端口，不能使用动态域名。')
      if (device.transport === 'rtu' && (!device.serialPath || device.dataBits !== 8 || !Number.isInteger(device.baudRate) || device.baudRate < 300 || device.baudRate > 4000000 || !['none', 'even', 'odd'].includes(device.parity) || ![1, 2].includes(device.stopBits) || !['none', 'rtscts', 'xonxoff'].includes(device.flowControl))) throw writeConflict('请核对 RTU 串口参数，数据位须为 8。')
      if (!(DATA_TYPES as readonly string[]).includes(r.dataType)) throw writeConflict('点位类型不受支持。')
      const width = registerWidth(r.dataType)
      if (!Number.isInteger(r.startAddress) || r.startAddress < 0 || !Number.isInteger(group.startAddress) || !Number.isInteger(group.quantity) || r.startAddress < group.startAddress || r.startAddress + width > group.startAddress + group.quantity || r.startAddress + width > 65536) throw writeConflict('点位字宽超出分组范围。')
      let covered = -1
      for (const item of [...registers].sort((a, b) => a.startAddress - b.startAddress || a.id - b.id)) {
        if (item.id === r.id && item.startAddress < covered) throw writeConflict('该地址已被前一个多字点位覆盖，请选择实际点位。')
        if (item.startAddress >= covered) covered = item.startAddress + registerWidth(item.dataType)
      }
      const parsed = parseRegisterWriteValue(r.dataType, value), type = baseType(r.dataType)
      if (/^(u?int)(16|32|64)$/.test(type)) {
        const n = BigInt(parsed), bits = BigInt(width * 16), unsigned = type.startsWith('u')
        if (typeof parsed === 'number' && !Number.isSafeInteger(parsed) || n < (unsigned ? 0n : -(1n << (bits - 1n))) || n > (unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n)) throw Object.assign(new Error('写入整数超出点位类型范围。'), { statusCode: 400 })
      }
      const words = encodeRegister(r.dataType, parsed)
      const decoded = decodeRegister(r.dataType, words)
      if (typeof decoded === 'number' && !Number.isFinite(decoded)) throw Object.assign(new Error('编码后数值无效。'), { statusCode: 400 })
      const channel = device.transport === 'tcp' ? `tcp:${device.ip.toLowerCase()}:${device.port}` : `rtu:${String(device.serialPath).toLowerCase().replace(/^\\\\\.\\/, '')}`
      if (db.prepare("SELECT id FROM register_write_operations WHERE channel=? AND state IN ('sending','unknown')").get(channel)) throw writeConflict('此通道有执行中或结果未知的写入，请先查询原操作并核实。')
      const plan: GuardedWritePlan = { version: 1, id: randomUUID(), scope: this.scope(), revision: this.revision(db), channel, source,
        value: String(parsed), words, functionCode: words.length === 1 ? 6 : 16, timeoutMs: Math.max(100, Math.min(60000, device.timeoutMs || 3000)), expiresAt: Date.now() + 120000 }
      db.prepare("INSERT INTO register_write_operations(id,channel,state,plan) VALUES(?,?,'prepared',?)").run(plan.id, channel, JSON.stringify(plan))
      return this.row(db, plan.id)
    })
  }
  claim(id: string) {
    return this.transaction(db => {
      const operation = this.row(db, id)
      if (operation.state !== 'prepared') return { operation, claimed: false }
      this.assertPlan(db, operation.plan)
      if (db.prepare("SELECT id FROM register_write_operations WHERE channel=? AND state IN ('sending','unknown')").get(operation.plan.channel)) throw writeConflict('通道已有未完成的操作。')
      db.prepare("UPDATE register_write_operations SET state='sending',message='正在发送，请勿重复操作。' WHERE id=?").run(id)
      return { operation: this.row(db, id), claimed: true }
    })
  }
  private assertPlan(db: DatabaseSync, plan: GuardedWritePlan) {
    if (plan.scope !== this.scope() || Date.now() > plan.expiresAt || this.revision(db) !== plan.revision) throw writeConflict()
    const graph = this.graph(plan.source.register.id)
    if (!graph.device || !graph.group || !graph.register || JSON.stringify(registerWriteSource(graph.device, graph.group, graph.register)) !== JSON.stringify(plan.source)) throw writeConflict()
  }
  send(plan: GuardedWritePlan, accept: () => void) {
    // This lock excludes other SQLite writers until bytes have been handed to the fixed native handle.
    // No SDK queue or reconnect callback can choose another target after this boundary.
    return this.transaction(db => {
      this.assertPlan(db, plan)
      const operation = this.row(db, plan.id)
      if (operation.state !== 'sending' || JSON.stringify(operation.plan) !== JSON.stringify(plan)) throw writeConflict('计划已执行或不匹配。')
      accept()
    })
  }
  finish(id: string, state: 'acknowledged' | 'not-sent' | 'unknown', message: string) {
    const db = this.database()
    db.prepare("UPDATE register_write_operations SET state=?,message=? WHERE id=? AND state='sending'").run(state, message, id)
    return this.get(id)
  }
  cancelPrepared(id: string) {
    return this.transaction(db => {
      this.row(db, id)
      // Serializes with claim: a late execute sees not-sent; an already claimed operation is untouched.
      db.prepare("UPDATE register_write_operations SET state='not-sent',message='已取消尚未提交的写入。' WHERE id=? AND state='prepared'").run(id)
      return this.row(db, id)
    })
  }
  reviewUnknown(id: string) {
    const operation = this.get(id)
    if (operation.state !== 'unknown') throw writeConflict('只能人工核实结果未知的操作。')
    this.database().prepare("UPDATE register_write_operations SET state='reviewed-unknown',message='用户已现场核实；原操作结果仍未知，不重发原计划。' WHERE id=? AND state='unknown'").run(id)
    return this.get(id)
  }
}
