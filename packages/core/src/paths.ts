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
