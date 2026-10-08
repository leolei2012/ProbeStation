/** Decode a Chat Completions stream, including fragmented tool arguments. */
export async function chatResponse(response: Response, signal: AbortSignal, onText?: (text: string) => void) {
  if (!response.ok) throw Object.assign(new Error(apiFailure(response.status)), { statusCode: 400 })
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await response.text()
    signal.throwIfAborted()
    if (text.length > 1_000_000) throw new Error('模型响应过大')
    const choice = JSON.parse(text)?.choices?.[0]
    if (choice?.finish_reason === 'length') throw new Error('模型输出不完整，请缩小问题范围')
    return choice?.message
  }
  if (!response.body) throw new Error('模型返回了空数据流')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', size = 0, content = '', reasoning = '', finished = false
  const calls: any[] = []
  const line = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data) return
    if (data === '[DONE]') { finished = true; return }
    const event = JSON.parse(data)
    if (event.error) throw new Error('模型流式响应失败')
    const choice = event.choices?.[0]
    if (!choice) return
    if (choice.finish_reason === 'length') throw new Error('模型输出不完整，请缩小问题范围')
    if (choice.finish_reason) finished = true
    const d = choice.delta ?? {}
    if (d.content) { content += d.content; onText?.(d.content) }
    if (d.reasoning_content) reasoning += d.reasoning_content
    for (const c of d.tool_calls ?? []) {
      if (!Number.isInteger(c.index) || c.index < 0 || c.index > 12) throw new Error('无效工具序号')
      const target = calls[c.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (c.id) target.id += c.id
      if (c.function?.name) target.function.name += c.function.name
      if (c.function?.arguments) target.function.arguments += c.function.arguments
    }
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 1_000_000) throw new Error('模型响应过大')
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split('\n'); buffer = lines.pop()!
      for (const value of lines) line(value.trimEnd())
    }
    buffer += decoder.decode(); if (buffer.trim()) line(buffer.trimEnd())
    if (!finished) throw new Error('连接中断，模型回答未完成')
    return { content, ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: calls.filter(Boolean) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function apiFailure(status: number) {
  const reason = status === 401 || status === 403 ? '密钥无效或没有访问权限' : status === 404 ? 'API 地址或模型不存在' : status === 429 ? '额度不足或请求过于频繁' : status >= 500 ? '模型服务暂时不可用' : '请求参数或模型不受支持'
  return `模型 API 返回 HTTP ${status}：${reason}。`
}
