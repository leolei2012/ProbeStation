import { resolve } from 'node:path'

/**
 * ProbeStation 唯一数据目录（已去除工作区抽象，固定为一个目录）。
 * 通过环境变量 PROBESTATION_DATA_DIR 可覆盖；否则为 <进程 cwd>/data。
 * config.db / poll.duckdb / firmware/ 都放在该目录下。
 */
export const DATA_DIR: string =
  process.env.PROBESTATION_DATA_DIR
    ? resolve(process.env.PROBESTATION_DATA_DIR)
    : resolve(process.cwd(), 'data')

/** 服务器本地时区的偏移分钟数（东八区为 480；`new Date().getTimezoneOffset()` 是反的，取负）。 */
export function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/**
 * 把存储的 UTC ISO 时间戳转成「服务器本地时区」的通用字符串。
 * 前后端对外展示统一用此口径（存储仍为 UTC）。
 * 输出格式：YYYY-MM-DD HH:mm:ss（无时区后缀，= 服务器本地时间）。
 */
export function localTs(iso: string | null | undefined): string {
  if (iso == null || iso === '') return ''
  let s = String(iso)
  // DuckDB TIMESTAMP 读回是无时区串（代表 UTC 时刻）；无 Z/±offset 后缀时按 UTC 补 Z，
  // 避免被当成 naive 本地时间而少了时差。
  if (!/[zZ]$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
