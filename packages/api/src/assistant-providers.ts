import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Context, AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai'

// Same provider runtime used by DSH llm-pi-ai; keep its native response metadata for replay.
const runtime = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } })
const enabled = new Set(['openai', 'anthropic', 'google', 'deepseek', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn', 'groq', 'mistral', 'openrouter', 'xai', 'zai', 'zai-coding-cn', 'together', 'cerebras', 'fireworks'])
export function providerCatalog() {
  return runtime.getProviders().filter(p => enabled.has(p.id)).map(p => ({ id: p.id, name: p.name, models: runtime.getModels(p.id).map(m => ({ id: m.id, name: m.name, baseUrl: m.baseUrl, efforts: ['default', ...getSupportedThinkingLevels(m)], contextWindow: m.contextWindow })) }))
}
export function providerModel(provider: string, id: string) {
  if (!enabled.has(provider)) throw new Error('不支持的提供商')
  const model = runtime.getModel(provider, id)
  if (!model) throw new Error('模型不在该提供商目录中，请选择目录模型或使用自定义兼容接口')
  return model
}
export async function providerCompletion(config: { provider: string; model: string; baseUrl: string; apiKey: string; effort: string }, messages: any[], tools: any[], signal: AbortSignal, fetcher: typeof fetch) {
  const original = providerModel(config.provider, config.model)
  const model = { ...original, baseUrl: config.baseUrl || original.baseUrl }
  if (!config.apiKey) throw new Error('请先保存该提供商的 API Key')
  const effort = config.effort === 'none' ? 'off' : config.effort
  if (effort !== 'default' && !getSupportedThinkingLevels(model).includes(effort as ModelThinkingLevel)) throw new Error('此模型不支持所选推理等级')
  const toolNames = new Map<string, string>()
  const context: Context = { systemPrompt: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), tools: tools.map(t => t.function), messages: [] }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') context.messages.push({ role: 'user', content: Array.isArray(m.content) ? m.content.map((c: any) => c.type === 'image_url' ? { type: 'image', mimeType: c.image_url.url.slice(5, c.image_url.url.indexOf(';')), data: c.image_url.url.split(',')[1] } : c) : m.content, timestamp: Date.now() })
    if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) toolNames.set(call.id, call.function.name)
      if (m._native) context.messages.push(m._native)
      else context.messages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...(m.tool_calls ?? []).map((c: any) => ({ type: 'toolCall', id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) }))], api: original.api, provider: original.provider, model: original.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: m.tool_calls?.length ? 'toolUse' : 'stop', timestamp: Date.now() } as AssistantMessage)
    }
    if (m.role === 'tool') context.messages.push({ role: 'toolResult', toolCallId: m.tool_call_id, toolName: toolNames.get(m.tool_call_id) ?? 'unknown', content: [{ type: 'text', text: m.content }], isError: false, timestamp: Date.now() })
  }
  const response = await runtime.completeSimple(model, context, { apiKey: config.apiKey, signal, fetch: (url, init) => fetcher(url, { ...init, redirect: 'error' }), transport: 'sse', maxTokens: Math.min(8192, model.maxTokens), maxRetries: 0, timeoutMs: 120000, ...(effort === 'default' || effort === 'off' ? {} : { reasoning: effort as any }) })
  signal.throwIfAborted()
  if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error('提供商请求失败，请检查密钥、模型或服务状态')
  if (response.stopReason === 'length') throw new Error('模型达到输出上限，请缩小问题或降低推理等级')
  return { content: response.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), tool_calls: response.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })), _native: response }
}
