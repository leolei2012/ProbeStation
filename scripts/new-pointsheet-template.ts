import ExcelJS from 'exceljs'
import { writeFileSync, mkdirSync, writeFileSync as write } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 生成“空白点位表 xlsx 模板” + 一份配套 README 文本。
// Excel 布局与 sink.exportPointSheet / importPointBook 完全一致：
//   - sheet「设备信息」仅供参考；
//   - 其余每个 sheet = 一个寄存器分组，第1/2行分组头、第4行列头、第5行起逐点。
// 导入会把「设备信息」之外的每个 sheet 当作一个分组。不要额外塞非设备信息 sheet，否则会被当分组。
// 真实使用：用这个模板改好点 → 用 Web/REST/MCP 的 import_points_xlsx 导回。

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const xlsxOut = resolve(root, 'docs/pointsheet-template-example.xlsx')
mkdirSync(dirname(xlsxOut), { recursive: true })

const wb = new ExcelJS.Workbook()

// 设备信息（仅供人读；导入忽略）
const info = wb.addWorksheet('设备信息')
info.columns = [{ header: 'key', key: 'k', width: 22 }, { header: 'value', key: 'v', width: 44 }]
;[['设备名', '示例设备'], ['连接', 'RTU:COM6 或 192.168.1.10:8899'], ['从站', '1'], ['扫描间隔ms', '1000'], ['分组数', '1']].forEach(([k, v]) => info.addRow({ k, v }))

// 示例分组 sheet
const s = wb.addWorksheet('SYS')
s.addRow(['分组', 'SYS'])                                        // 第1行
s.addRow(['从站', 1, '功能码', 3, '起始地址', 0, '数量', 100])     // 第2行分组头
s.addRow([])                                                     // 第3行空
s.addRow(['别名', '数据类型', '单位', '系数', '偏移', '枚举', '功能码', '起始地址', '数量']) // 第4行列头
s.addRow(['加热器温度', 'int16', '℃', 0.1, 0, '', 3, 0, 1])        // 第5行起：逐点
s.addRow(['目标转速', 'uint16', 'rpm', 1, 0, '', 3, 1, 1])
s.addRow(['工作模式', 'int16', '', 1, 0, '0=OFF;1=ON', 3, 2, 1])

const buf = await wb.xlsx.writeBuffer()
writeFileSync(xlsxOut, Buffer.from(buf))

// 配套 README
write(xlsxOut.replace(/\.xlsx$/, '') + '.txt',
`点位表 xlsx 模板示例（详见 docs/product/10-点位表xlsx规范与模板.md）

用途：这是一张“分组=sheet”的可导回点表模板。
- sheet「设备信息」：参考用，导入会忽略。
- sheet「SYS」：一个分组示例；第一行=分组名，第二行=分组头(从站/功能码/起始/数量)，
  第三行留空，第四行=列头(别名|数据类型|单位|系数|偏移|枚举|功能码|起始地址|数量)，
  第五行起每行一个寄存器(点)。增行=加点，删行删点。

多分组：多建几个 sheet(名字=你们分段名，如 RO/RW/MT/TEST)，每个 sheet 用同样前三行+列头+点。

导回：让设备里该点的分组/寄存器全量被这个文件重建。
- Web：设备 实时数据 → ⬆ 导入点表.xlsx
- REST：POST /api/monitor_objects/:id/points/book  (body=xlsx 二进制)
- MCP：import_points_xlsx(device_id, content_b64)
`)
console.log('已生成空点位表模板: ' + xlsxOut)
