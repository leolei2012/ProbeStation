/** 纯函数 Modbus 类型编解码器：位宽(16/32/64) × 端序(大端默认/小端 -LE)；hex/bin 为各宽度的原始显示格式。 */
export const DATA_TYPES = [
  'int16', 'uint16', 'float16', 'q15', 'hex16', 'bin16',
  'int32', 'uint32', 'float32', 'q31', 'hex32', 'bin32',
  'int64', 'uint64', 'float64', 'hex64', 'bin64',
  'int16-LE', 'uint16-LE', 'float16-LE', 'q15-LE', 'hex16-LE', 'bin16-LE',
  'int32-LE', 'uint32-LE', 'float32-LE', 'q31-LE', 'hex32-LE', 'bin32-LE',
  'int64-LE', 'uint64-LE', 'float64-LE', 'hex64-LE', 'bin64-LE',
] as const
export type DataType = (typeof DATA_TYPES)[number]
export type RegisterValue = number | bigint

export function baseType(type: string): string { return type.replace(/-LE$|_LE$/i, '') }
export function isLittleEndian(type: string): boolean { return baseType(type) !== type }
export function registerWidth(type: string): 1 | 2 | 4 {
  const b = baseType(type)
  if (b === 'q31') return 2
  if (b.endsWith('32')) return 2
  if (b.endsWith('64')) return 4
  return 1
}
export function isHexType(type: string): boolean { return baseType(type).startsWith('hex') }
export function isBinType(type: string): boolean { return baseType(type).startsWith('bin') }

function swap16(w: number): number { return ((w & 0xff) << 8) | ((w >> 8) & 0xff) }

/** 应用端序：16 位=字节交换，32/64 位=字序反转。 */
export function applyEndianness(type: string, words: number[]): number[] {
  if (!isLittleEndian(type)) return words
  if (words.length > 1) return [...words].reverse()
  return [swap16(words[0] ?? 0)]
}

function halfToNumber(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 31) return frac === 0 ? sign * Infinity : NaN
  return sign * 2 ** (exp - 15) * (1 + frac / 1024)
}

function floatToHalf(f: number): number {
  const buf = new ArrayBuffer(4)
  const dv = new DataView(buf)
  dv.setFloat32(0, f, false)
  const bits = dv.getUint32(0, false)
  const sign = (bits >>> 16) & 0x8000
  const exp32 = (bits >>> 23) & 0xff
  const mant32 = bits & 0x7fffff
  if (exp32 === 0xff) return sign | 0x7c00 | (mant32 !== 0 ? 0x200 : 0)
  const exp = exp32 - 127 + 15
  if (exp >= 0x1f) return sign | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign
    return sign | (((mant32 | 0x800000) >> (1 - exp)) >> 13)
  }
  return sign | (exp << 10) | (mant32 >> 13)
}

function wordsToUint64(words: number[]): bigint {
  let r = 0n
  for (let i = 0; i < 4; i++) r = (r << 16n) | BigInt(words[i] ?? 0)
  return r
}
function wordsToInt64(words: number[]): bigint {
  let u = wordsToUint64(words)
  if (u >= 2n ** 63n) u -= 2n ** 64n
  return u
}
function uint64ToWords(v: bigint): number[] {
  const out: number[] = []
  for (let i = 0; i < 4; i++) { out.unshift(Number(v & 0xffffn)); v >>= 16n }
  return out
}
function int64ToWords(v: bigint): number[] {
  if (v < 0n) v += 2n ** 64n
  return uint64ToWords(v)
}

function decodeBE(type: string, words: number[]): RegisterValue {
  const w0 = words[0] ?? 0
  if (type === 'int16') return w0 > 0x7fff ? w0 - 0x10000 : w0
  if (type === 'uint16') return w0
  if (type === 'float16') return halfToNumber(w0)
  if (type === 'q15') return (w0 > 0x7fff ? w0 - 0x10000 : w0) / 32768
  const w1 = words[1] ?? 0
  const u32 = ((w0 << 16) | w1) >>> 0
  if (type === 'int32') return u32 | 0
  if (type === 'q31') return (u32 | 0) / 2147483648
  if (type === 'uint32') return u32
  if (type === 'float32') {
    const buf = new ArrayBuffer(4)
    const dv = new DataView(buf)
    dv.setUint16(0, w0, false)
    dv.setUint16(2, w1, false)
    return dv.getFloat32(0, false)
  }
  if (type === 'int64') return wordsToInt64(words)
  if (type === 'uint64') return wordsToUint64(words)
  if (type === 'float64') {
    const buf = new ArrayBuffer(8)
    const dv = new DataView(buf)
    for (let i = 0; i < 4; i++) dv.setUint16(i * 2, words[i] ?? 0, false)
    return dv.getFloat64(0, false)
  }
  return w0
}

function encodeBE(type: string, value: number | bigint): number[] {
  const num = () => Number(value)
  if (type === 'int16') { const v = num() | 0; return [v & 0xffff] }
  if (type === 'uint16') return [Math.max(0, Math.min(0xffff, Math.round(num())))]
  if (type === 'float16') return [floatToHalf(num())]
  if (type === 'q15') { const v = Math.max(-1, Math.min(1 - 1 / 32768, num())); return [Math.round(v * 32768) & 0xffff] }
  if (type === 'int32') { const v = num() | 0; return [(v >>> 16) & 0xffff, v & 0xffff] }
  if (type === 'q31') { const v = Math.max(-1, Math.min(1 - 1 / 2147483648, num())); const i = Math.round(v * 2147483648) | 0; return [(i >>> 16) & 0xffff, i & 0xffff] }
  if (type === 'uint32') { const v = num() >>> 0; return [Math.floor(v / 0x10000) & 0xffff, v & 0xffff] }
  if (type === 'float32') {
    const buf = new ArrayBuffer(4)
    const dv = new DataView(buf)
    dv.setFloat32(0, num(), false)
    return [dv.getUint16(0, false), dv.getUint16(2, false)]
  }
  if (type === 'int64') return int64ToWords(BigInt(value))
  if (type === 'uint64') return uint64ToWords(BigInt(value))
  if (type === 'float64') {
    const buf = new ArrayBuffer(8)
    const dv = new DataView(buf)
    dv.setFloat64(0, num(), false)
    const out: number[] = []
    for (let i = 0; i < 4; i++) out.push(dv.getUint16(i * 2, false))
    return out
  }
  return [Math.round(num()) & 0xffff]
}

function encodeRaw(base: string, value: number | bigint): number[] {
  const w = registerWidth(base)
  if (w === 1) return [Number(value) & 0xffff]
  if (w === 2) { const v = Number(value) >>> 0; return [Math.floor(v / 0x10000) & 0xffff, v & 0xffff] }
  return uint64ToWords(BigInt(value))
}

function decodeRaw(base: string, words: number[]): RegisterValue {
  const w = registerWidth(base)
  if (w === 1) return words[0] ?? 0
  if (w === 2) return ((words[0] << 16) | words[1]) >>> 0
  return wordsToUint64(words)
}

export function decodeRegister(type: string, words: number[]): RegisterValue {
  const base = baseType(type)
  const norm = applyEndianness(type, words)
  return (isHexType(type) || isBinType(type)) ? decodeRaw(base, norm) : decodeBE(base, norm)
}

export function encodeRegister(type: string, value: number | bigint): number[] {
  const base = baseType(type)
  const be = (isHexType(type) || isBinType(type)) ? encodeRaw(base, value) : encodeBE(base, value)
  return applyEndianness(type, be)
}

export function toHex(word: number): string {
  return '0x' + (word & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}

export function toBin(word: number): string {
  return (word & 0xffff).toString(2).padStart(16, '0')
}

export function formatNumber(d: number | bigint): string {
  if (typeof d === 'bigint') return d.toString()
  if (Number.isNaN(d)) return 'NaN'
  if (!Number.isFinite(d)) return d > 0 ? 'Inf' : '-Inf'
  return Number.isInteger(d) ? String(d) : String(Number(d.toPrecision(7)))
}

export interface DecodableRegister { id: number; startAddress: number; dataType: string }

/** 把原始字按类型格式化成显示字符串：hex/bin 逐字、数值按 formatNumber。 */
export function formatRegisterValue(dataType: string, words: number[]): string {
  const dispWords = applyEndianness(dataType, words)
  if (isHexType(dataType)) return dispWords.map(toHex).join(' ')
  if (isBinType(dataType)) return dispWords.map(toBin).join(' ')
  return formatNumber(decodeRegister(dataType, words))
}

/** 按寄存器收集相邻地址的原始字；被覆盖或数据不足返回 null。 */
function collectWordsByAddr(registers: DecodableRegister[], rawByAddr: Record<number, number>): Map<number, { words: number[]; dataType: string } | null> {
  const sorted = [...registers].sort((a, b) => a.startAddress - b.startAddress)
  const out = new Map<number, { words: number[]; dataType: string } | null>()
  let consumedUpTo = -Infinity
  for (const r of sorted) {
    const w = registerWidth(r.dataType)
    if (r.startAddress < consumedUpTo) { out.set(r.id, null); continue }
    const words: number[] = []
    for (let a = r.startAddress; a < r.startAddress + w; a++) {
      const v = rawByAddr[a]
      if (v === undefined) break
      words.push(v)
    }
    if (words.length !== w) { out.set(r.id, null); continue }
    out.set(r.id, { words, dataType: r.dataType })
    consumedUpTo = r.startAddress + w
  }
  return out
}

/** 把「地址 → 原始 16 位字」按寄存器解码成完整数值；被覆盖或数据不足返回 null。 */
export function decodeRawByAddr(registers: DecodableRegister[], rawByAddr: Record<number, number>): Map<number, number | bigint | null> {
  const out = new Map<number, number | bigint | null>()
  for (const [id, info] of collectWordsByAddr(registers, rawByAddr)) {
    out.set(id, info === null ? null : decodeRegister(info.dataType, info.words))
  }
  return out
}

/** 把「地址 → 原始 16 位字」按寄存器解码成显示字符串（hex/bin 逐字）；被覆盖或数据不足返回 null。 */
export function formatRawByAddr(registers: DecodableRegister[], rawByAddr: Record<number, number>): Map<number, string | null> {
  const out = new Map<number, string | null>()
  for (const [id, info] of collectWordsByAddr(registers, rawByAddr)) {
    out.set(id, info === null ? null : formatRegisterValue(info.dataType, info.words))
  }
  return out
}

// ── 语义层：scale(×factor+offset) + enum ─────────────────────

export interface SemanticRegister {
  dataType: string
  factor: number
  offset: number
  unit: string | null
  enumMap: Record<string, string> | null
}

/** 解析 enum_json 字符串为映射（key 为裸整数值的字符串）。 */
export function parseEnum(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null
  try {
    const o = JSON.parse(json)
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, string> : null
  } catch { return null }
}

/** 把已解码的寄存器值做语义翻译：enum 命中返回 label，否则 ×factor+offset。 */
export function resolveSemantic(reg: SemanticRegister, decoded: number | bigint): { value: number | string; unit: string | null; label: string | null } {
  if (reg.enumMap && typeof decoded !== 'bigint' && Number.isInteger(decoded)) {
    const label = reg.enumMap[String(decoded)]
    if (label != null) return { value: decoded, unit: reg.unit, label }
  }
  const physical = Math.round((Number(decoded) * reg.factor + reg.offset) * 1e9) / 1e9
  return { value: physical, unit: reg.unit, label: null }
}

/** 把物理值逆变换成寄存器值（写入用）：(物理 - offset) / factor。 */
export function invertSemantic(reg: SemanticRegister, physical: number): number {
  const f = reg.factor === 0 ? 1 : reg.factor
  return (physical - reg.offset) / f
}
