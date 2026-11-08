/** Internal classification only: SQL had no open transaction before the observer ran. */
export class CommittedConfigurationNotificationError extends Error {
  declare readonly statusCode?: number
  declare readonly code?: string
  constructor(cause: unknown) {
    super('配置数据库操作已提交，但变更通知未完成；通知和运行状态待核实，请核对当前配置，勿重复操作。', { cause })
    // Preserve existing HTTP error metadata without exposing the observer's private message.
    try {
      if (cause !== null && typeof cause === 'object') {
        const metadata = cause as { statusCode?: unknown; code?: unknown }
        const status = metadata.statusCode, code = metadata.code
        if (typeof status === 'number') this.statusCode = status
        if (typeof code === 'string') this.code = code
      }
    } catch { /* Unreadable diagnostic metadata must not replace the original cause. */ }
  }
}
