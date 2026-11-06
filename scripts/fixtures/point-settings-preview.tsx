import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PointSettingsEditor, type PointSettings } from '../../apps/web/src/PointSettingsEditor'
import '../../apps/web/src/styles.css'
import type { PointSettingsUpdate } from '../../apps/web/src/point-settings'
import { capturePointEditBaseline, parsePointEditRequest, pointEditMatches, type PointEditBaseline } from '../../packages/core/src/point-settings-edit'
import { saveGuardedPointSettings } from '../../apps/web/src/point-settings-save'
import { DeviceModal } from '../../apps/web/src/DeviceModal'
import { captureDeviceEditBaseline, deviceEditMatches, parseDeviceEditRequest, type DeviceEditBaseline } from '../../packages/core/src/device-settings-edit'
import { saveGuardedDeviceSettings } from '../../apps/web/src/device-settings-save'
import type { SerialPortList } from '../../apps/web/src/serial-ports'

const group = { id: 1, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 4, mode: 'read' }
const device = { id: 1, mode: 'master', slaveId: 1, transport: 'tcp', ip: 'mock.invalid', port: 502, serialPath: null, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none' }
const point = (settings: PointSettings) => ({ ...settings, id: 1, objectId: 1, groupId: 1, alias: 'synthetic', functionCode: 3, startAddress: 0 })
const mockPorts = async (): Promise<SerialPortList> => ({ ports: [{ path: 'MOCK_PORT_1', description: '合成端口，不枚举或打开实机' }, { path: 'MOCK_PORT_2' }], source: 'mock', location: 'backend', enumerationOnly: true })

const scenarios = [
  { name: '无枚举', value: null }, { name: '原有空白和补零键', value: ' { "01": " On ", "-2": " Off " } ' },
  { name: '规范化后重复键', value: '{"01":"A","1":"B"}' }, { name: 'JSON 损坏', value: '{broken' },
  { name: '数组', value: '["unexpected"]' }, { name: '非字符串标签', value: '{"1":123}' },
  { name: '空对象', value: '{}' }, { name: '500 条映射', value: JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i, '模拟标签 ' + i]))) },
]

const words: Record<string, string> = {
  editDeviceTitle: '编辑模拟设备', newDeviceTitle: '新建模拟设备', name: '名称', transport: '连接方式', transportTcp: 'TCP', transportRtu: 'RTU', ip: 'IP/主机名', port: '端口', baudRate: '波特率', parity: '校验位', stopBits: '停止位', flowControl: '流控', slaveIdLabel: '从站地址', pollIntervalLabel: '扫描间隔', timeoutLabel: '超时', pollIntervalHint: '仅页面模拟，不采集。', timeoutHint: '仅页面模拟，不连接。',
  pointSettings: '点位设置（纯模拟）', colAddr: '地址', colType: '类型', types: '模拟数值类型', pointUnit: '单位', pointFactor: '系数', pointOffset: '偏移', pointDecimals: '物理值小数位', pointDecimalsAuto: '自动',
  pointScaleHint: '物理值 = 原始值 × 系数 + 偏移。修改只保存在页面内存，不连接设备、不读写配置库。', pointZeroFactorHint: '系数为 0：有效原始值的物理换算结果等于偏移。原始采样值和告警比较不受影响。',
  pointInvalidScale: '系数和偏移必须填写有限数（系数可为 0）。', valueShort: '类型字宽超出分组', enumConfig: '枚举', enumHint: '不填时无枚举；也可测试重复值或空名称的校验。', enumValue: '原始整数', enumLabel: '标签', enumEmpty: '无枚举', enumLabelPlaceholder: '显示文字', enumRemove: '删除', enumAdd: '添加枚举', enumClear: '清空枚举',
  enumInvalidValue: '枚举值应为整数', enumDuplicate: '枚举值 {value} 重复', enumEmptyLabel: '请填写枚举标签', cancel: '取消', save: '保存到页面内存', working: '处理中', operationFailed: '模拟保存失败',
}
function Preview() {
  const [settings, setSettings] = useState<PointSettings>({ dataType: 'uint32', unit: '旧单位', factor: 0, offset: 12.5, enumJson: null, decimalPlaces: 1 })
  const [show, setShow] = useState(false), [failOnce, setFailOnce] = useState(false)
  const [patch, setPatch] = useState<PointSettingsUpdate | null>(null)
  const [concurrent, setConcurrent] = useState(false)
  const [conflict, setConflict] = useState(false), [baseline, setBaseline] = useState<PointEditBaseline | null>(null)
  const [showDevice, setShowDevice] = useState(false), [deviceConflict, setDeviceConflict] = useState(false), [deviceWarning, setDeviceWarning] = useState(false)
  const [deviceSettings, setDeviceSettings] = useState<DeviceEditBaseline>(() => ({ ...device, name: '模拟设备', pollIntervalMs: 1000, timeoutMs: 3000 }))
  const [deviceResult, setDeviceResult] = useState('尚未保存')
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 点位设置流程</h1>
    <p>无服务、数据库或设备；保存只更新此页面内存。关闭页面即丢弃模拟配置。</p>
    <h2>设备编辑并发保护（纯模拟）</h2>
    <p>可切到RTU查看模拟端口；注入固定清单，不枚举或打开系统端口。正常保存、冲突保留草稿和已保存但运行状态警告均只发生在页面内存。</p>
    <label><input type="checkbox" checked={deviceConflict} onChange={e => setDeviceConflict(e.target.checked)} />保存前模拟其他用户修改设备IP</label>
    <label><input type="checkbox" checked={deviceWarning} onChange={e => setDeviceWarning(e.target.checked)} />模拟配置已保存但连接应用失败</label>
    <button className="btn" disabled={show || showDevice} onClick={() => setShowDevice(true)}>编辑模拟设备</button>
    <pre>{deviceResult}</pre><pre>{JSON.stringify(deviceSettings, null, 2)}</pre>
    {showDevice && <DeviceModal t={key => words[key] ?? key} initial={deviceSettings} portFetcher={mockPorts} onClose={() => setShowDevice(false)} onSave={async (fields, expected) => {
      if (!expected) throw new Error('缺少模拟编辑快照')
      const warnings = await saveGuardedDeviceSettings(expected, fields, async (_url, body) => {
        const current = { ...deviceSettings, ...(deviceConflict ? { ip: 'new.mock.invalid' } : {}) }; setDeviceSettings(current)
        const request = parseDeviceEditRequest(body)
        if (!deviceEditMatches(captureDeviceEditBaseline(current), request.expected)) throw new Error('HTTP 409 设备配置已变更，本次未保存。草稿已保留；请记录修改、关闭并重开。')
        const saved = { ...current, ...request.changes }; setDeviceSettings(saved)
        return { device: saved, warnings: deviceWarning ? ['配置已保存；模拟连接应用失败，不代表配置未保存。'] : [] }
      })
      setDeviceResult(['配置已保存（模拟）', ...warnings].join(' · ')); setShowDevice(false)
    }} />}
    <h2>点位设置（纯模拟）</h2>
    <p>将“旧单位”改名后保持系数 0 保存并重新打开；再测试清空数字、负倍率、枚举重复、取消及失败重试。可缩至360px检查布局。</p>
    <p>原枚举不改动时，请检查下方发送字段中没有 enumJson；明确替换或清空后才会发送该字段。大映射可分页，错误会定位所在页。</p>
    <div className="toolbar">{scenarios.map(scenario => <button key={scenario.name} className="btn" disabled={show || showDevice} onClick={() => { setSettings(previous => ({ ...previous, enumJson: scenario.value })); setPatch(null) }}>{scenario.name}</button>)}</div>
    <label><input type="checkbox" checked={concurrent} onChange={e => setConcurrent(e.target.checked)} />保存前模拟其他用户更新枚举（仅页面内存）</label>
    <label><input type="checkbox" checked={conflict} onChange={e => setConflict(e.target.checked)} />保存前模拟其他用户更改单位，应拒绝旧草稿（仅页面内存）</label>
    <label><input type="checkbox" checked={failOnce} onChange={e => setFailOnce(e.target.checked)} />下次保存模拟失败一次，随后允许重试</label>
    <button className="btn" disabled={show || showDevice} onClick={() => { setBaseline(capturePointEditBaseline(point(settings), group, device)); setShow(true) }}>编辑模拟点位</button>
    <pre aria-label="页面内存配置">{JSON.stringify(settings, null, 2)}</pre>
    <pre aria-label="最近发送字段">{patch === null ? '尚未保存' : JSON.stringify(patch, null, 2)}</pre>
    {show && baseline && <PointSettingsEditor guarded name="模拟点位 · 不接触实机" address={0} settings={settings} available={4}
      typeGroups={[{ key: 'types', types: ['uint16', 'uint32', 'uint64', 'hex32', 'bin32'] }]} t={key => words[key] ?? key} onClose={() => setShow(false)} onSave={async next => {
        if (failOnce) { setFailOnce(false); throw new Error('模拟保存失败：草稿保持不变，可直接再次保存。') }
        await saveGuardedPointSettings(baseline, next, async (_url, body) => {
          const current = { ...settings, ...(concurrent ? { enumJson: '{"7":"模拟并发更新"}' } : {}), ...(conflict ? { unit: '模拟并发单位' } : {}) }
          setSettings(current)
          const request = parsePointEditRequest(body)
          if (!pointEditMatches(capturePointEditBaseline(point(current), group, device), request.expected, request.changes)) throw new Error('HTTP 409 配置已变更，本次未保存。草稿已保留；请记录修改，关闭并重新打开。')
          const saved = { ...current, ...request.changes }
          setPatch(next); setSettings(saved)
          return { point: point(saved), warnings: [] }
        })
      }} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
