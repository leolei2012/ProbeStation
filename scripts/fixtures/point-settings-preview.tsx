import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PointSettingsEditor, type PointSettings } from '../../apps/web/src/PointSettingsEditor'
import '../../apps/web/src/styles.css'

const words: Record<string, string> = {
  pointSettings: '点位设置（纯模拟）', colAddr: '地址', colType: '类型', types: '模拟数值类型', pointUnit: '单位', pointFactor: '系数', pointOffset: '偏移', pointDecimals: '物理值小数位', pointDecimalsAuto: '自动',
  pointScaleHint: '物理值 = 原始值 × 系数 + 偏移。修改只保存在页面内存，不连接设备、不读写配置库。', pointZeroFactorHint: '系数为 0：有效原始值的物理换算结果等于偏移。原始采样值和告警比较不受影响。',
  pointInvalidScale: '系数和偏移必须填写有限数（系数可为 0）。', valueShort: '类型字宽超出分组', enumConfig: '枚举', enumHint: '不填时无枚举；也可测试重复值或空名称的校验。', enumValue: '原始整数', enumLabel: '标签', enumEmpty: '无枚举', enumLabelPlaceholder: '显示文字', enumRemove: '删除', enumAdd: '添加枚举', enumClear: '清空枚举',
  enumInvalidValue: '枚举值应为整数', enumDuplicate: '枚举值 {value} 重复', enumEmptyLabel: '请填写枚举标签', cancel: '取消', save: '保存到页面内存', working: '处理中', operationFailed: '模拟保存失败',
}
function Preview() {
  const [settings, setSettings] = useState<PointSettings>({ dataType: 'uint32', unit: '旧单位', factor: 0, offset: 12.5, enumJson: null, decimalPlaces: 1 })
  const [show, setShow] = useState(false), [failOnce, setFailOnce] = useState(false)
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 点位设置流程</h1>
    <p>无服务、数据库或设备；保存只更新此页面内存。关闭页面即丢弃模拟配置。</p>
    <p>将“旧单位”改名后保持系数 0 保存并重新打开；再测试清空数字、负倍率、枚举重复、取消及失败重试。可缩至360px检查布局。</p>
    <label><input type="checkbox" checked={failOnce} onChange={e => setFailOnce(e.target.checked)} />下次保存模拟失败一次，随后允许重试</label>
    <button className="btn" onClick={() => setShow(true)}>编辑模拟点位</button>
    <pre aria-label="页面内存配置">{JSON.stringify(settings, null, 2)}</pre>
    {show && <PointSettingsEditor name="模拟点位 · 不接触实机" address={0} settings={settings} available={4}
      typeGroups={[{ key: 'types', types: ['uint16', 'uint32', 'uint64', 'hex32', 'bin32'] }]} t={key => words[key] ?? key} onClose={() => setShow(false)} onSave={async next => {
        if (failOnce) { setFailOnce(false); throw new Error('模拟保存失败：草稿保持不变，可直接再次保存。') }
        setSettings(next)
      }} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
