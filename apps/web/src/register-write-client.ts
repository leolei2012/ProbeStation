import { registerWriteChannel, type GuardedWriteResult, type RegisterWriteSource } from '../../../packages/core/src/guarded-register-write'

async function request(path: string, body: unknown, timeout: number, fetcher: typeof fetch): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-probestation-write': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error([data?.message, data?.error].find(value => typeof value === 'string' && value.trim()) || `HTTP ${response.status}`), { code: data?.code, status: response.status })
    return data
  } finally { clearTimeout(timer) }
}
function validResult(data: any): data is GuardedWriteResult {
  return !!data && data.version === 1 && typeof data.id === 'string' && data.plan?.version === 1 && data.plan?.id === data.id && Array.isArray(data.plan.words) && data.plan.words.length >= 1 && data.plan.words.length <= 4 && data.plan.words.every((w: unknown) => Number.isInteger(w) && Number(w) >= 0 && Number(w) <= 65535) && !!data.plan.source?.device && !!data.plan.source?.group && !!data.plan.source?.register && Number.isFinite(data.plan.expiresAt) && Number.isFinite(data.plan.timeoutMs) && ['prepared', 'sending', 'acknowledged', 'not-sent', 'unknown', 'reviewed-unknown'].includes(data.state)
}
export async function writeRequest(path: string, body?: unknown, timeout = 15000, fetcher: typeof fetch = fetch): Promise<GuardedWriteResult> {
  const data = await request(path, body, timeout, fetcher)
  if (!validResult(data)) throw new Error('后台返回了不支持的写入协议，请核对前后端版本。')
  return data
}
export async function pendingWritesRequest(source: RegisterWriteSource, fetcher: typeof fetch = fetch): Promise<GuardedWriteResult[]> {
  const data = await request('/api/registers/' + source.register.id + '/write/pending', undefined, 15000, fetcher)
  if (data?.version !== 1 || data.deviceId !== source.device.id || data.registerId !== source.register.id || data.channel !== registerWriteChannel(source.device) || !Array.isArray(data.operations) || data.operations.some((row: any) => !validResult(row) || row.plan.channel !== data.channel || !['sending', 'unknown'].includes(row.state))) throw new Error('未完成写入状态无法核实，请更新后台或重新打开窗口。')
  return data.operations
}

