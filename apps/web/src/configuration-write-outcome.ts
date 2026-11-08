export const CONFIG_WRITE_NOT_STARTED = 'CONFIG_WRITE_NOT_STARTED'

/** A v1 refusal envelope is closed; mixed success payloads and unknown extensions are not proof. */
export function configurationWriteReceipt(data: unknown, status: number, report = false): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const value = data as Record<string, unknown>
  return status === 503 && value.version === 1 && value.code === CONFIG_WRITE_NOT_STARTED && value.outcome === 'not-applied' && typeof value.error === 'string' && Object.keys(value).every(key => report && key === 'report' || ['error', 'version', 'code', 'outcome'].includes(key))
}

/** A receipt is a backend report, not proof of this request's outcome. */
export function configurationWriteReport(creating = false, english = false): string {
  return english ? `Backend reports ${creating ? 'creation' : 'write'} blocked. Receipt is not bound to this request; actual outcome is unverified. Ask an administrator to check configuration; do not repeat the operation.` : `后台报告${creating ? '创建' : '写入'}受阻；回执未绑定请求，本次实际结果待核实。请管理员核查配置，勿直接重复操作。`
}

/** Interpret a received server refusal; this does not authenticate it or establish request identity. */
export function configurationWriteBlocked(error: unknown, creating = false, english = false): Error | null {
  const state = error as { statusCode?: unknown; version?: unknown; code?: unknown; outcome?: unknown } | null
  if (!(error instanceof Error) || state?.statusCode !== 503 || state.version !== 1 || state.code !== CONFIG_WRITE_NOT_STARTED || state.outcome !== 'not-applied') return null
  return new Error(configurationWriteReport(creating, english))
}
