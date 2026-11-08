export const CONFIG_WRITE_NOT_STARTED = 'CONFIG_WRITE_NOT_STARTED'

/** A v1 refusal envelope is closed; mixed success payloads and unknown extensions are not proof. */
export function configurationWriteReceipt(data: unknown, status: number, report = false): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const value = data as Record<string, unknown>
  return status === 503 && value.version === 1 && value.code === CONFIG_WRITE_NOT_STARTED && value.outcome === 'not-applied' && typeof value.error === 'string' && Object.keys(value).every(key => report && key === 'report' || ['error', 'version', 'code', 'outcome'].includes(key))
}

/** Interpret a received server refusal; this does not authenticate it or establish request identity. */
export function configurationWriteBlocked(error: unknown, creating = false, english = false): Error | null {
  const state = error as { statusCode?: unknown; version?: unknown; code?: unknown; outcome?: unknown } | null
  if (!(error instanceof Error) || state?.statusCode !== 503 || state.version !== 1 || state.code !== CONFIG_WRITE_NOT_STARTED || state.outcome !== 'not-applied') return null
  return new Error(english ? `This ${creating ? 'creation' : 'save'} did not run: configuration is quarantined. Keep the draft in this window. Ask an administrator to inspect and restore the service; verify configuration before submitting again. Earlier request outcomes remain separate and unverified.` : `本次${creating ? '创建' : '保存'}未执行，配置连接已隔离。草稿保留在当前窗口；请管理员核查并恢复后再核对配置，勿直接重复${creating ? '创建' : '保存'}。之前请求结果仍须单独核实。`)
}
