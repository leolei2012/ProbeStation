/** 纯函数 Modbus 类型编解码器（无依赖，仅 16 位类型：int16 / uint16 / float16）。 */
export const DATA_TYPES = ['int16', 'uint16', 'float16'] as const
export type DataType = (typeof DATA_TYPES)[number]

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

/** 把 16 位字按类型解码成 JS number。 */
export function decodeRegister(type: string, word: number): number {
  if (type === 'int16') return word > 0x7fff ? word - 0x10000 : word
  if (type === 'uint16') return word
  if (type === 'float16') return halfToNumber(word)
  return word
}

/** 把 JS number 按类型编码成单个 16 位字。 */
export function encodeRegister(type: string, value: number): number {
  if (type === 'int16') { const v = value | 0; return v & 0xffff }
  if (type === 'uint16') return Math.max(0, Math.min(0xffff, Math.round(value)))
  if (type === 'float16') return floatToHalf(value)
  return Math.round(value) & 0xffff
}

/** 16 位字 → 0x 十六进制字符串（4 位大写）。 */
export function toHex(word: number): string {
  return '0x' + (word & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}
