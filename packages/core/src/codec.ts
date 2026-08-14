/** 纯函数 Modbus 类型编解码器（无依赖）：16/32/64 位；大端（默认）/ 小端（-LE 后缀）词序。 */
export const DATA_TYPES = [
  'int16', 'uint16', 'float16',
  'int32', 'uint32', 'float32', 'int64', 'uint64', 'float64',
  'int32-LE', 'uint32-LE', 'float32-LE', 'int64-LE', 'uint64-LE', 'float64-LE',
] as const
export type DataType = (typeof DATA_TYPES)[number]
export type RegisterValue = number | bigint

/** 去掉 -LE/_LE 后缀得到基础类型。 */
export function baseType(type: string): string {
  return type.replace(/-LE$|_LE$/i, '')
}

/** 是否小端词序（低字在低地址）。 */
export function isLittleEndian(type: string): boolean {
  return baseType(type) !== type
}

/** 该类型占用的连续 16 位寄存器个数。 */
export function registerWidth(type: string): 1 | 2 | 4 {
  const b = baseType(type)
  if (b === 'int32' || b === 'uint32' || b === 'float32') return 2
  if (b === 'int64' || b === 'uint64' || b === 'float64') return 4
  return 1
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

/** 大端序解码基础类型（低地址=高字）。 */
function decodeBE(type: string, words: number[]): RegisterValue {
  const w0 = words[0] ?? 0
  if (type === 'int16') return w0 > 0x7fff ? w0 - 0x10000 : w0
  if (type === 'uint16') return w0
  if (type === 'float16') return halfToNumber(w0)
  const w1 = words[1] ?? 0
  const u32 = ((w0 << 16) | w1) >>> 0
  if (type === 'int32') return u32 | 0
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

/** 大端序编码基础类型为 16 位字数组。 */
function encodeBE(type: string, value: number | bigint): number[] {
  const num = () => Number(value)
  if (type === 'int16') { const v = num() | 0; return [v & 0xffff] }
  if (type === 'uint16') return [Math.max(0, Math.min(0xffff, Math.round(num())))]
  if (type === 'float16') return [floatToHalf(num())]
  if (type === 'int32') { const v = num() | 0; return [(v >>> 16) & 0xffff, v & 0xffff] }
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

/** 把 16 位字数组按类型（含端序）解码成 JS number/bigint。 */
export function decodeRegister(type: string, words: number[]): RegisterValue {
  const ws = isLittleEndian(type) && words.length > 1 ? [...words].reverse() : words
  return decodeBE(baseType(type), ws)
}

/** 把 JS number/bigint 按类型（含端序）编码成 16 位字数组。 */
export function encodeRegister(type: string, value: number | bigint): number[] {
  const words = encodeBE(baseType(type), value)
  return isLittleEndian(type) && words.length > 1 ? [...words].reverse() : words
}

/** 16 位字 → 0x 十六进制字符串（4 位大写）。 */
export function toHex(word: number): string {
  return '0x' + (word & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}
