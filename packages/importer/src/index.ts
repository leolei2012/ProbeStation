import type { Context } from 'cordis'
import { XMLParser } from 'fast-xml-parser'

export const name = 'importer'
export const inject = ['config']

export interface ParsedGroup { name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; mode: string }
export interface ParsedRegister { alias: string; functionCode: number; startAddress: number; quantity: number; dataType: string }
export interface ParsedResult { groups: ParsedGroup[]; registers: ParsedRegister[]; warnings: string[] }

const FORMAT_HINT: Record<string, string> = { '0': 'int16', '1': 'uint16', '2': 'int32', '3': 'uint32', '4': 'float32' }
const FN_MAP: Record<string, number> = { '01': 1, '02': 2, '03': 3, '04': 4, '05': 5, '06': 6, '15': 15, '16': 16 }

function parseMbpXml(text: string): ParsedResult {
  const parser = new XMLParser({ ignoreAttributes: false })
  let root: any
  try { root = parser.parse(text) } catch { throw new Error('XML parse error') }
  const poll = root.ModbusPoll ?? root
  const groups: ParsedGroup[] = []
  const registers: ParsedRegister[] = []
  const warnings: string[] = []
  const datas = Array.isArray(poll.Data) ? poll.Data : (poll.Data ? [poll.Data] : [])
  for (const data of datas) {
    const fn = Number(data.Function ?? 3)
    const start = Number(data.Address ?? 0)
    const qty = Number(data.Quantity ?? 1)
    const names: Record<number, string> = {}
    const cells = data.CellData?.Cell
    if (cells) for (const cell of (Array.isArray(cells) ? cells : [cells])) {
      const idx = Number(cell['@_idx'])
      if (!Number.isNaN(idx) && cell.Name) names[idx] = String(cell.Name)
    }
    const fmts: Record<number, number> = {}
    const fs = data.Formats?.F
    if (fs) (Array.isArray(fs) ? fs : [fs]).forEach((f: any, i: number) => { fmts[i] = Number(f['@_f'] ?? 0) })
    for (let idx = 0; idx < qty; idx++) {
      const addr = start + idx
      registers.push({ alias: names[idx] ?? 'Addr' + addr, functionCode: fn, startAddress: addr, quantity: 1, dataType: FORMAT_HINT[String(fmts[idx] ?? 0)] ?? 'int16' })
    }
    groups.push({ name: (fn === 3 && start === 0) ? 'Holding Registers' : 'FC' + fn + '_Addr' + start, slaveId: 1, functionCode: fn, startAddress: start, quantity: qty, mode: 'read' })
  }
  if (registers.length === 0) warnings.push('No register data found in .mbp file')
  return { groups, registers, warnings }
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let cur: Record<string, string> | null = null
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith(';') || t.startsWith('#')) continue
    const sm = t.match(/^\[(.+)\]$/)
    if (sm) { cur = {}; sections[sm[1]] = cur; continue }
    const kv = t.match(/^([^=]+)=(.*)$/)
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim()
  }
  return sections
}

function parseMbpIni(text: string): ParsedResult {
  const groups: ParsedGroup[] = []
  const registers: ParsedRegister[] = []
  const warnings: string[] = []
  const sections = parseIni(text)
  for (const [name, cfg] of Object.entries(sections)) {
    if (!name.toLowerCase().startsWith('window')) continue
    const fnStr = cfg['Function'] ?? '03'
    const fn = FN_MAP[fnStr] ?? (Number.isFinite(Number(fnStr)) ? Number(fnStr) : 3)
    const addrStr = cfg['Address'] ?? '0'
    const a = Number(addrStr)
    const start = addrStr.startsWith('4') ? a - 40001 : addrStr.startsWith('3') ? a - 30001 : Math.max(0, a - 1)
    const qty = Number(cfg['Quantity'] ?? '1')
    const alias = cfg['Alias'] ?? 'Addr' + start
    const dataType = cfg['Data Type'] ?? 'int16'
    groups.push({ name, slaveId: 1, functionCode: fn, startAddress: start, quantity: qty, mode: 'read' })
    registers.push({ alias, functionCode: fn, startAddress: start, quantity: qty, dataType })
  }
  if (registers.length === 0) warnings.push('No valid register windows found in .mbp file')
  return { groups, registers, warnings }
}

export function parseMbp(content: Buffer): ParsedResult {
  const text = content.toString('utf-8').replace(/^\uFEFF/, '')
  const t = text.trim()
  if (t.startsWith('<?xml') || t.startsWith('<ModbusPoll>')) return parseMbpXml(text)
  return parseMbpIni(text)
}

export function parseMbs(content: Buffer): ParsedResult {
  if (content.length < 120) throw new Error('File too small to be a valid .mbs file')
  const funcCode = content.readUInt32LE(12)
  const quantity = content.readUInt32LE(16)
  const slaveId = content.readUInt32LE(20)
  const names = extractUtf16Names(content)
  let valid = names.filter(isValidName).map(cleanName).filter(Boolean)
  if (valid.length === 0) valid = Array.from({ length: quantity }, (_, i) => 'Addr' + i)
  const registers: ParsedRegister[] = valid.slice(0, quantity).map((alias, i) => ({ alias, functionCode: funcCode, startAddress: i, quantity: 1, dataType: 'int16' }))
  const fcNames: Record<number, string> = { 1: 'Coils', 2: 'Discrete Inputs', 3: 'Holding Registers', 4: 'Input Registers' }
  return {
    groups: [{ name: (fcNames[funcCode] ?? 'FC' + funcCode) + '-0x0000', slaveId, functionCode: funcCode, startAddress: 0, quantity: registers.length, mode: 'read_write' }],
    registers,
    warnings: [],
  }
}

function extractUtf16Names(data: Buffer): string[] {
  const names: string[] = []
  let i = 0
  while (i < data.length - 4) {
    const nullPos = data.indexOf(Buffer.from([0, 0]), i)
    if (nullPos === -1) break
    const chunk = data.subarray(i, nullPos)
    if (chunk.length >= 4 && chunk.length % 2 === 0) {
      try {
        const s = chunk.toString('utf16le').replace(/\0+$/, '').trim()
        if (s) names.push(stripFontPrefix(s))
      } catch { /* skip */ }
    }
    i = nullPos + 2
  }
  return names
}

const FONTS = ['Microsoft YaHei UI', 'Microsoft YaHei', 'SimSun', 'SimHei']
function stripFontPrefix(s: string): string {
  let out = s.replace(/^\uFEFF/, '').replace(/^\uFFFE/, '')
  for (const f of FONTS) {
    const idx = out.indexOf(f)
    if (idx >= 0) {
      let after = out.slice(idx + f.length).replace(/[\uE000-\uF8FF]/g, '')
      if (after.trim()) return after.trim()
      break
    }
  }
  return out
}

function cleanName(s: string): string {
  let out = s.replace(/^[\uFEFF\uFFFE]+/, '')
  while (out && out.charCodeAt(0) >= 0x600 && out.charCodeAt(0) < 0x1000) out = out.slice(1)
  return out.trim()
}

function isValidName(s: string): boolean {
  if (!s || s.length <= 1) return false
  const cjk = /[\u4e00-\u9fff\u3000-\u303f]/.test(s)
  const ascii = [...s].every(c => c.charCodeAt(0) < 128)
  if (!cjk && !(ascii && s.length >= 2)) return false
  return !FONTS.includes(s)
}

export function apply(ctx: Context): void {
  ctx.provide('importer', {
    import(objectId: number, filename: string, content: Buffer) {
      const parsed = filename.toLowerCase().endsWith('.mbs') ? parseMbs(content) : parseMbp(content)
      const groups = parsed.groups.map(g => ctx.config.createGroup(objectId, g.name, g.functionCode, g.startAddress, g.quantity, g.mode))
      const first = groups[0]
      const registers = parsed.registers.map(r => ctx.config.createRegister(first.id, objectId, r.alias, r.functionCode, r.startAddress, r.dataType))
      return { groups: groups.length, registers: registers.length, warnings: parsed.warnings }
    },
  })
}
