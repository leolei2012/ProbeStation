/** Independent metadata, not a protocol read count or dtype width.
 * Positive JS safe integers round-trip exactly through JSON and SQLite INTEGER.
 */
export function parseRegisterQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new Error('点位 quantity 必须为正安全整数'), { statusCode: 400 })
  }
  return value
}
