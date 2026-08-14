/** 纯函数 Modbus 类型编解码器（无依赖，供 web 前端 + api/mcp 后端共用）。 */
export const DATA_TYPES = ['int16', 'uint16', 'float16', 'int32', 'uint32', 'float32'] as const
export type DataType = (typeof DATA_TYPES)[number]

/** 该类型占用的 16 位寄存器个数。 */
export function registerWidth(type: string): 1 | 2 {
  return type === 'int32' || type === 'uint32' || type === 'float32' ? 2 : 1
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

/** 把大端序的 16 位字数组解码成 JS number（32 位类型合并两个字）。 */
export function decodeRegister(type: string, words: number[]): number {
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
  return w0
}

/** 把 JS number 编码成大端序 16 位字数组（32 位类型产生两个字）。 */
export function encodeRegister(type: string, value: number): number[] {
  if (type === 'int16') { const v = value | 0; return [v & 0xffff] }
  if (type === 'uint16') return [Math.max(0, Math.min(0xffff, Math.round(value)))]
  if (type === 'float16') return [floatToHalf(value)]
  if (type === 'int32') { const v = value | 0; return [(v >>> 16) & 0xffff, v & 0xffff] }
  if (type === 'uint32') { const v = value >>> 0; return [Math.floor(v / 0x10000) & 0xffff, v & 0xffff] }
  if (type === 'float32') {
    const buf = new ArrayBuffer(4)
    const dv = new DataView(buf)
    dv.setFloat32(0, value, false)
    return [dv.getUint16(0, false), dv.getUint16(2, false)]
  }
  return [Math.round(value) & 0xffff]
}

/** 16 位字 → 0x 十六进制字符串（4 位大写）。 */
export function toHex(word: number): string {
  return '0x' + (word & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}
