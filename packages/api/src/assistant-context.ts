/** Estimate input size without counting duplicated provider metadata or base64 as text tokens. */
export function estimateContextTokens(messages: any[], tools: any[] = []): number {
  const text = JSON.stringify({ messages, tools }, (key, value) => key === '_native' ? undefined : key === 'url' && typeof value === 'string' && value.startsWith('data:image/') ? '[image]' : value)
  let ascii = 0, other = 0, images = 0
  for (const char of text) if (char.codePointAt(0)! <= 127) ascii++; else other++
  for (const message of messages) if (Array.isArray(message.content)) images += message.content.filter((part: any) => part.type === 'image_url').length
  // This is a conservative estimate, not a provider tokenizer. The API remains authoritative.
  return Math.ceil(ascii / 4 + other * 1.5 + messages.length * 8 + images * 2048)
}
export function contextBudget(window: number | null) {
  if (!window || !Number.isSafeInteger(window) || window < 1) return null
  const outputReserve = Math.min(8192, Math.floor(window / 4))
  return { window, outputReserve, compactAt: Math.floor((window - outputReserve) * 0.9) }
}
