import type { GuardedWriteResult } from '../../../packages/core/src/guarded-register-write'

export async function writeRequest(path: string, body?: unknown, timeout = 15000, fetcher: typeof fetch = fetch): Promise<GuardedWriteResult> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-probestation-write': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error([data?.message, data?.error].find(value => typeof value === 'string' && value.trim()) || `HTTP ${response.status}`)
    if (data.version !== 1 || typeof data.id !== 'string' || data.plan?.version !== 1 || data.plan?.id !== data.id || !Array.isArray(data.plan.words) || data.plan.words.length < 1 || data.plan.words.length > 4 || data.plan.words.some((w: unknown) => !Number.isInteger(w) || Number(w) < 0 || Number(w) > 65535) || !data.plan.source?.device || !data.plan.source?.group || !data.plan.source?.register || !Number.isFinite(data.plan.expiresAt) || !Number.isFinite(data.plan.timeoutMs) || !['prepared', 'sending', 'acknowledged', 'not-sent', 'unknown', 'reviewed-unknown'].includes(data.state)) throw new Error('后台返回了不支持的写入协议，请核对前后端版本。')
    return data
  } finally { clearTimeout(timer) }
}

