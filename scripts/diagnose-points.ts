/** Offline JSON only: never imports ConfigStore, CLI bootstrap or a device driver. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { diagnosePointTable, PointTableInputError } from '../packages/core/src/point-diagnostics.ts'

export function diagnosePointsCli(args: string[], read: (path: string) => string = path => readFileSync(path, 'utf8')) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean' } } })
    const usage = '用法：npm run diagnose:points -- [--json] <点表或配置备份.json>\n仅检查显式指定的 JSON，不打开配置/历史库，不导入或修改文件。错误退出码1，警告退出码0，输入失败退出码2。'
    if (values.help) return { exitCode: 0, output: usage }
    if (positionals.length !== 1) return { exitCode: 2, output: usage }
    if (!positionals[0].toLowerCase().endsWith('.json')) return { exitCode: 2, output: '仅接受显式指定的 .json 文件；不会读取数据库文件。' }
    let input: unknown
    try { input = JSON.parse(read(positionals[0]).replace(/^\uFEFF/, '')) } catch { return { exitCode: 2, output: '无法读取或解析指定的 JSON 文件；未打开数据库或修改配置。' } }
    const envelope = input as any
    if (envelope?.format !== undefined && (envelope.format !== 'probestation-config' || envelope.version !== 1)) throw new PointTableInputError('配置备份格式或版本不支持。')
    const report = diagnosePointTable(input)
    const text = [`离线点表诊断：${report.summary.errors} 个错误，${report.summary.warnings} 个警告；覆盖占位行 ${report.summary.coveredPlaceholders}。`, '范围仅为点表结构，不代表设备在线、采样有效或测试通过。', ...report.issues.map(i => `${i.severity === 'error' ? '错误' : '警告'} [${i.code}] ${i.path ?? ''}${i.registerIds ? ' 点位 ' + i.registerIds.join(',') : ''} ${i.message}`)].join('\n')
    return { exitCode: report.ok ? 0 : 1, output: values.json ? JSON.stringify(report, null, 2) : text }
  } catch (error) { return { exitCode: 2, output: error instanceof PointTableInputError ? error.message : '命令参数无效；使用 --help 查看用法。' } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = diagnosePointsCli(process.argv.slice(2)); console.log(result.output); process.exitCode = result.exitCode
}
