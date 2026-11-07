import { baseType, isBinType, isHexType, parseRawRegisterInput, registerWidth } from './codec.ts'

/** User input boundary only. Existing codec rounding, saturation and bit-width behavior is unchanged. */
export function parseRegisterWriteValue(dataType: string, value: unknown): number | bigint {
  if (!['string', 'number', 'bigint'].includes(typeof value) || typeof value === 'string' && !value.trim()) throw new Error('请输入明确的数值；不能使用空值、布尔值、数组或对象。')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('写入值必须为有限数值。')
  if (isHexType(dataType) || isBinType(dataType)) return parseRawRegisterInput(dataType, value as string | number | bigint)
  const base = baseType(dataType)
  if (base === 'int64' || base === 'uint64') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('64位整数的数字输入必须为安全整数；大整数请使用整数字符串。')
    return BigInt(String(value))
  }
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('写入值必须为有限数值。')
  return number
}

/** JSON-safe, preserving the existing raw-radix UI payload and exact 64-bit integer text. */
export function registerWritePayloadValue(dataType: string, input: unknown): string | number {
  const value = parseRegisterWriteValue(dataType, input)
  if (typeof value === 'number') return value
  if (isHexType(dataType) || isBinType(dataType)) return registerWidth(dataType) < 4 ? Number(value) : isHexType(dataType) ? '0x' + value.toString(16) : '0b' + value.toString(2)
  return value.toString()
}
