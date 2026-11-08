/** An instance-local quarantine, not a statement about whether the original mutation committed. */
export class ConfigurationTransactionUnconfirmedError extends Error {
  readonly statusCode = 503
  readonly code = 'CONFIG_TRANSACTION_UNCONFIRMED'
  constructor(cause: unknown) {
    super('配置数据库事务结果未确认，此连接已隔离；请核对并显式重开配置，勿自动重试。', { cause })
    this.name = 'ConfigurationTransactionUnconfirmedError'
  }
}
