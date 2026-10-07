export type AssistantConfig = { provider?: string; baseUrl: string; model: string; hasKey: boolean; reasoningProtocol?: 'default' | 'reasoning_effort' }

export async function assistantRequest(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch('/api/ai' + path, { method, headers: { 'Content-Type': 'application/json', 'X-ProbeStation-AI': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const result = await res.json()
  if (!res.ok) throw new Error(result.error || result.message || `HTTP ${res.status}`)
  return result
}

export type ProviderInfo = { id: string; name: string; models: { id: string; name: string; baseUrl: string; efforts: string[] }[] }
