/** Fail closed until a reviewed send-binding capability exists. No environment/config unlock. */
export function deviceWriteRefusal() {
  return {
    version: 1, code: 'DEVICE_WRITE_BLOCKED', retryable: false,
    error: '直接写值/升级已停用：尚不能核实发送来源与结果，请勿重试。重启、重连、修改配置或确认旧结果均不会解禁；需经审查的发送绑定与恢复流程。此前在途请求及其他程序的操作结果仍须单独核实。',
    recovery: 'reviewed-send-binding-required',
  } as const
}
