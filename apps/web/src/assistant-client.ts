export type AssistantConfig = { provider?: string; baseUrl: string; model: string; hasKey: boolean; reasoningProtocol?: 'default' | 'reasoning_effort'; contextWindow?: number | null }

export async function assistantRequest(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch('/api/ai' + path, { method, headers: { 'X-ProbeStation-AI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const result = await res.json()
  if (!res.ok) throw Object.assign(new Error(result.message || result.error || `HTTP ${res.status}`), { status: res.status })
  return result
}

export type ProviderInfo = { id: string; name: string; models: { id: string; name: string; baseUrl: string; efforts: string[]; contextWindow?: number }[] }
