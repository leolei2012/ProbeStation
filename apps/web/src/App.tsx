import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import './styles.css'
import { decodeHistorySeries, nearestHistorySample, type HistoryPoint } from './history-curve'
import { sampleCurve, type CurveBuffer } from './live-curve'
import { pointHealth, sampleTime, staleAfterMs, type Sample } from './observation'
import { baseType, decodeRawByAddr, decodeRegister, formatNumber, formatRawByAddr, formatRegisterValue, isBinType, isHexType, parseEnum, registerWidth } from '../../../packages/core/src/codec.ts'

const TYPE_GROUPS = [
  { key: 'grp16BE', types: ['int16', 'uint16', 'float16', 'hex16', 'bin16'] },
  { key: 'grp16LE', types: ['int16-LE', 'uint16-LE', 'float16-LE', 'hex16-LE', 'bin16-LE'] },
  { key: 'grp32BE', types: ['int32', 'uint32', 'float32', 'hex32', 'bin32'] },
  { key: 'grp32LE', types: ['int32-LE', 'uint32-LE', 'float32-LE', 'hex32-LE', 'bin32-LE'] },
  { key: 'grp64BE', types: ['int64', 'uint64', 'float64', 'hex64', 'bin64'] },
  { key: 'grp64LE', types: ['int64-LE', 'uint64-LE', 'float64-LE', 'hex64-LE', 'bin64-LE'] },
]

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number; transport: string; serialPath: string | null; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number; dataRetainSeconds: number | null; connected: boolean }
type DeviceFields = { name: string; ip: string; port: number; transport: string; serialPath: string; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null }
interface DeviceGroup { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number; registers: Register[] }
interface LatestValue extends Sample {}

type Lang = 'zh' | 'en'
type Theme = 'light' | 'dark' | 'system'
type T = (key: string) => string
type RealtimeStatus = 'connecting' | 'connected' | 'stale' | 'reconnecting' | 'disconnected'

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    histMinutes: "最近 {n} 分钟", histHours: "最近 {n} 小时", histNoNumeric: "所选点位没有可绘制的数值数据，请检查类型或选择其他点位。", histZoomIn: "放大", histZoomOut: "缩小", histMoveEarlier: "向前移动时间窗口", histMoveLater: "向后移动时间窗口", histQueryZoom: "查询放大区间", histRelative: "各曲线相对量程", histInteractionHint: "悬停查看读数 · 左右拖动框选时间范围 · 双击恢复全范围", histNoVisible: "当前范围没有可见曲线，可重置缩放或点击下方图例显示曲线。", histNearest: "最近采样点（实际时间）", histLegendHint: "点击图例隐藏 / 显示曲线", histStatsHint: "当前可见时间范围的显示数据统计", histLastValue: "末值", histSamplingNote: "曲线为分桶后的原始解码值：每桶每地址保留最后一个值。Min / Max 是显示点的统计，可能遗漏瞬时峰值；放大后可点击“查询放大区间”提高时间分辨率。", histRelativeNote: "相对量程将每条曲线映射为 0–100%，恒定值显示在 50%；悬停和统计仍为原始数值。",
    liveCurve: '实时曲线', liveWindow: '时间窗口', freezeCurve: '暂停画面', resumeCurve: '继续实时', clearCurve: '清空曲线', curveWaiting: '等待新的有效采样数据…', liveCurveHint: '本次打开设备期间缓存；每 250ms 取最新值，最多 8 条曲线、每条 2400 点，保留最近 10 分钟。暂停仅冻结画面，不停止采集。', liveRawHint: '按寄存器类型解码原始值，不应用倍率/偏移；不绘制非有限数和无法精确表示的 64 位整数。', curvePaused: '画面已暂停，后台继续缓存', curveTracking: '实时跟随', curveNoNumeric: '暂无可绘制的数值点位，请先配置寄存器。', curveSelectLimit: '最多选择 {n} 个点位', curveTime: '时间',

    groupOldValues: '存在旧值', groupPartialData: '数据不完整', groupCommunicationError: '通信异常', groupTimeHint: '按组内最早的采样时间显示，避免部分数据未更新被掩盖',
    resizeSidebar: '调整侧边栏宽度', resizeSidebarHint: '拖动调整宽度，双击恢复默认；也可使用左右方向键',
    sortDevices: '调整顺序', finishSorting: '完成排序', moveUp: '上移', moveDown: '下移', dragDevice: '拖动排序', sortingHint: '拖动手柄或点击箭头调整顺序，自动保存在当前浏览器。排序时显示全部设备。', orderSaveFailed: '顺序已调整，但浏览器无法保存；刷新后可能恢复。',
    observe: "观测", configure: "配置", searchPoints: "搜索点位名称或地址", onlyIssues: "只看异常 / 过期", noMatchingPoints: "没有匹配的点位", lastSample: "最近采样", notSampled: "尚未采集", secondsAgo: "{n} 秒前", fresh: "数据新鲜", oldValue: "旧值", coveredWord: "合并占位", shortData: "数据不足", pausedData: "采集已暂停", sampling: "采集中", connectionPending: "等待通信", pageConnection: "页面实时连接异常，正在自动重连；暂用定时查询更新数据。", ageHint: "数据超过 {n} 秒未更新将标记为旧值（按轮询配置估算）", operationOk: "操作成功", operationFailed: "操作失败", working: "处理中…", dismiss: "关闭提示", requiredFields: "请填写名称和连接地址", pointStatus: "数据状态", updatedAt: "更新时间", currentValue: "当前值", noActiveGroups: "没有启用的分组", readOnly: "只读", pointWriteHint: "写入会改变设备值，请核对设备和地址。", importResult: "已导入 {g} 组 / {r} 个点位", loadFailed: "加载失败", refresh: "重试加载",
    searchDevices: '搜索设备或地址', noSearchResults: '没有匹配的设备', expandNav: '展开导航', collapseNav: '收起导航', overview: '设备概览', transportLabel: '通信协议', pointsLabel: '配置点位', groupsLabel: '采集分组', faultsLabel: '异常分组',
    brand: 'ProbeStation',
    brandSub: '设备观测与测试',
    newDevice: '新建设备',
    devices: '设备',
    noDevices: '暂无设备，点上方新建',
    workspace: '工作区',
    switchWorkspace: '切换工作区', addWorkspace: '添加工作区', newWorkspace: '新工作区', createdAt: '创建于',
    wsPath: '工作区路径',
    selectFolder: '选择此文件夹',
    upFolder: '上一级',
    recentWs: '最近使用',
    settings: '设置',
    emptyHint: '选择左侧设备，或新建设备开始观测',
    polling: '轮询中',
    stopped: '已停用',
    connected: '已连接',
    disconnected: '未连接',
    realtimeConnected: '实时通道正常', realtimeConnecting: '实时通道连接中', realtimeStale: '实时数据延迟', realtimeReconnecting: '实时通道重连中（第 {n} 次）', realtimeDisconnected: '实时通道已断开',
    groupDisconnected: '已断开',
    connect: '连接',
    disconnect: '断开',
    pause: '暂停',
    resume: '启用', enable: '使能',
    export: '导出', exportTitle: '导出数据', exportCsv: '导出 CSV',
    exportXlsx: '导出 XLSX',
    deleteDevice: '删除设备', deleteGroup: '删除分组', confirmDeleteDevice: '确定删除设备「{name}」？其下所有分组与寄存器将一并删除。', confirmDeleteGroup: '确定删除分组「{name}」？其下所有寄存器将一并删除。',
    regCount: '{n} 个寄存器',
    colAlias: '描述', colAddr: '地址', colType: '类型', colValue: '值', colQuality: '质量', colWrite: '写值', writeReg: '写寄存器', fc16: 'FC16 写多个寄存器', fc06: 'FC06 写单个寄存器', valueHint: '双击值可写入', valueCovered: '被上一个多字寄存器占用', valueShort: '数据不足（分组读取范围不够）', grp16BE: '16位 大端', grp16LE: '16位 小端', grp32BE: '32位 大端', grp32LE: '32位 小端', grp64BE: '64位 大端', grp64LE: '64位 小端',
    write: '写', valuePh: '值', writeErrEmpty: '请输入值', writeErrNaN: '请输入有效数字', writeOk: '已写入',
    noRegisters: '暂无寄存器（可通过 API 导入 MBS/MBP 文件）',
    settingsTitle: '设置', settingsSub: '外观、语言与数据管理',
    tabLive: '实时数据', tabHistory: '历史数据', tabCurve: '曲线', tabFirmware: '固件', tabRaw: '原始数据', histTable: '表格',
    groupCount: '{n} 组',
    newGroup: '新建分组', importPointBook: '导入点位', exportPointBook: '导出点位', editGroup: '编辑分组', groupName: '组名', slaveId: '从站 ID', functionCode: '功能码', startAddress: '起始地址', quantity: '数量', edit: '编辑', save: '保存', fcReadCoils: '读线圈', fcReadDiscrete: '读离散输入', fcReadHolding: '读保持寄存器', fcReadInput: '读输入寄存器',
    histHint: '最近 1 小时数据', histStart: '开始时间', histEnd: '结束时间', histQuery: '查询', histLoading: '查询中…', histPrev: '上一页', histNext: '下一页', histFirst: '首页', histLast: '末页', histTotal: '共 {n} 条', histPage: '第 {x}/{y} 页', noHistory: '暂无历史数据', colTime: '时间', histTruncated: '结果较多，仅显示最近 {n} 条', histIdle: '选择时间范围后点击「查询」', histEmpty: '该时间段暂无历史数据', histError: '查询失败', histRangeInvalid: '开始时间必须早于结束时间', histLast1h: '最近 1 小时', histLast6h: '最近 6 小时', histLast24h: '最近 24 小时', histToday: '今天', histQuick: '快捷', selectRegisters: '选择寄存器', selectAll: '全选', clearAll: '清空', histNoRegs: '未选择任何寄存器', curveHint: '最近 1 小时曲线', curveReset: '重置缩放', curveZoomHint: '框选放大：左上→右下拖拽；恢复：右下→左上拖拽', firmwareHint: '暂无固件，请先上传', fwUpload: '上传固件', fwAbort: '中止升级', fwState: '状态', fwUpgrade: '升级', fwUploaded: '固件已上传', fwUploadErr: '上传失败', fwStarted: '升级已发起', fwUpgradeErr: '升级发起失败', fwDelete: '删除', fwDeleted: '固件已删除', fwDeleteErr: '删除失败', confirmDeleteFirmware: '确定删除固件 {name} 吗？',
    appearance: '外观', themeLabel: '主题', light: '浅色', dark: '深色', system: '跟随系统',
    language: '语言',
    appInfo: '应用信息', version: '版本', arch: '架构', persistence: '持久化',
    dataMgmt: '数据管理', runLogs: '运行日志', clearLogs: '清空日志', logsCleared: '日志已清空', retentionLabel: '历史保留', retentionSaved: '保留时长已保存', retentionForever: '永久',
    newDeviceTitle: '新建设备', editDeviceTitle: '编辑设备', name: '名称', ip: 'IP 地址', port: '端口', transport: '连接方式', transportTcp: 'TCP 网口', transportRtu: 'RTU 串口', serialPath: '串口路径', baudRate: '波特率', parity: '校验位', stopBits: '停止位', dataBits: '数据位', flowControl: '流控', slaveIdLabel: '从站地址', pollIntervalLabel: '扫描间隔(ms)', pollIntervalHint: '按分组轮流轮询，每个分组约每「间隔 × 分组数」刷新一次', timeoutLabel: '读写超时(ms)', timeoutHint: '读/写寄存器请求的超时，默认 3000 毫秒（超过判失败）', cancel: '取消', add: '添加',
    importPoints: '导入点表', importTitle: '智能导入点表', importHint: '粘贴 CSV（首行表头含 地址/名称/类型/枚举 等列），或上传 CSV/XLSX 文件；也支持 JSON 数组。', importPh: '粘贴点表 CSV（首行表头：地址,名称,类型,枚举）', importFile: '上传文件', importDo: '导入', importEmpty: '请输入内容或选择文件', impBadJson: '无法解析 JSON 数组', importUpdated: '更新 {n} 个', importSkipped: '跳过 {n} 个', importErrors: '错误', importColumns: '识别列',
    tabMonitor: '设备观测', tabDatabase: '数据库', dbHistory: '历史数据', dbTotalRows: '采样总行数', dbTimeSpan: '时间跨度', dbDiskUsage: '磁盘占用', dbPerDevice: '每台设备', dbMetadata: '元数据', dbRetention: '保留策略', dbRefresh: '刷新', dbNoData: '暂无历史数据', dbBufferHint: '内存缓冲 {n} 条待落盘', dbDevices: '设备', dbGroups: '分组', dbRegisters: '寄存器', dbRules: '告警规则', dbFirmwares: '固件', dbLogs: '日志', dbRetentionForever: '永久', dbRetentionDays: '{n} 天',
  },
  en: {
    histMinutes: "Last {n} minutes", histHours: "Last {n} hours", histNoNumeric: "No plottable numeric data. Check types or select other points.", histZoomIn: "Zoom in", histZoomOut: "Zoom out", histMoveEarlier: "Move earlier", histMoveLater: "Move later", histQueryZoom: "Query zoomed range", histRelative: "Relative scale per series", histInteractionHint: "Hover for values · Drag horizontally to select time · Double-click to reset", histNoVisible: "No visible series in this range. Reset zoom or enable a legend item.", histNearest: "Nearest samples (actual times)", histLegendHint: "Click a legend item to hide / show", histStatsHint: "Statistics of displayed samples in the visible range", histLastValue: "Last", histSamplingNote: "Bucketed raw decoded values: the last value per address in each bucket. Min / Max describe displayed samples and may miss transient peaks. Query the zoomed range for finer resolution.", histRelativeNote: "Each series maps to 0–100%; constant values appear at 50%. Readouts and statistics retain raw values.",
    liveCurve: 'Live curves', liveWindow: 'Time window', freezeCurve: 'Freeze view', resumeCurve: 'Resume live', clearCurve: 'Clear curves', curveWaiting: 'Waiting for new valid samples…', liveCurveHint: 'Buffered while this device is open. Latest values sampled every 250ms; up to 8 series, 2400 points each, retained for 10 minutes. Freezing does not stop acquisition.', liveRawHint: 'Raw values decoded by register type, without factor/offset. Non-finite values and unsafe 64-bit integers are omitted.', curvePaused: 'View frozen; buffering continues', curveTracking: 'Following live data', curveNoNumeric: 'No numeric points available. Configure registers first.', curveSelectLimit: 'Select up to {n} points', curveTime: 'Time',

    groupOldValues: 'Stale data present', groupPartialData: 'Incomplete data', groupCommunicationError: 'Communication error', groupTimeHint: 'Shows the oldest sample in the group so partial updates do not hide stale data',
    resizeSidebar: 'Resize sidebar', resizeSidebarHint: 'Drag to resize, double-click to reset, or use Left and Right arrow keys',
    sortDevices: 'Reorder', finishSorting: 'Done', moveUp: 'Move up', moveDown: 'Move down', dragDevice: 'Drag to reorder', sortingHint: 'Drag the handle or use the arrows. Saved in this browser. All devices are shown while reordering.', orderSaveFailed: 'Order changed, but browser storage is unavailable; it may reset on reload.',
    observe: "Observe", configure: "Configure", searchPoints: "Search point name or address", onlyIssues: "Issues / stale only", noMatchingPoints: "No matching points", lastSample: "Latest sample", notSampled: "Not sampled", secondsAgo: "{n}s ago", fresh: "Fresh", oldValue: "Old value", coveredWord: "Merged word", shortData: "Incomplete data", pausedData: "Sampling paused", sampling: "Sampling", connectionPending: "Awaiting communication", pageConnection: "Live page connection interrupted. Reconnecting; using periodic snapshots meanwhile.", ageHint: "Values older than {n}s are marked stale (estimated from polling settings)", operationOk: "Operation succeeded", operationFailed: "Operation failed", working: "Working…", dismiss: "Dismiss", requiredFields: "Enter a name and connection address", pointStatus: "Data status", updatedAt: "Updated", currentValue: "Current value", noActiveGroups: "No enabled groups", readOnly: "Read only", pointWriteHint: "Writing changes the device value. Check the device and address.", importResult: "Imported {g} groups / {r} points", loadFailed: "Loading failed", refresh: "Retry loading",
    searchDevices: 'Search devices or addresses', noSearchResults: 'No matching devices', expandNav: 'Expand navigation', collapseNav: 'Collapse navigation', overview: 'Device overview', transportLabel: 'Transport', pointsLabel: 'Configured points', groupsLabel: 'Register groups', faultsLabel: 'Group faults',
    brand: 'ProbeStation',
    brandSub: 'Device observation & testing',
    newDevice: 'New Device',
    devices: 'Devices',
    noDevices: 'No devices, create one above',
    workspace: 'Workspace',
    switchWorkspace: 'Switch workspace', addWorkspace: 'Add workspace', newWorkspace: 'New workspace', createdAt: 'Created',
    wsPath: 'Workspace path',
    selectFolder: 'Select this folder',
    upFolder: 'Parent',
    recentWs: 'Recent',
    settings: 'Settings',
    emptyHint: 'Select a device or create one to start',
    polling: 'Polling',
    stopped: 'Stopped',
    connected: 'Connected',
    disconnected: 'Disconnected',
    realtimeConnected: 'Live channel connected', realtimeConnecting: 'Live channel connecting', realtimeStale: 'Live data delayed', realtimeReconnecting: 'Live channel reconnecting (attempt {n})', realtimeDisconnected: 'Live channel disconnected',
    groupDisconnected: 'Disconnected',
    connect: 'Connect',
    disconnect: 'Disconnect',
    pause: 'Pause',
    resume: 'Resume', enable: 'Enable',
    export: 'Export', exportTitle: 'Export data', exportCsv: 'Export CSV',
    exportXlsx: 'Export XLSX',
    deleteDevice: 'Delete', deleteGroup: 'Delete group', confirmDeleteDevice: 'Delete device "{name}"? All its groups and registers will be removed.', confirmDeleteGroup: 'Delete group "{name}"? All its registers will be removed.',
    regCount: '{n} registers',
    colAlias: 'Description', colAddr: 'Addr', colType: 'Type', colValue: 'Value', colQuality: 'Quality', colWrite: 'Write', writeReg: 'Write register', fc16: 'FC16 Write multiple', fc06: 'FC06 Write single', valueHint: 'Double-click a value to write', valueCovered: 'Covered by previous register', valueShort: 'Not enough polled data', grp16BE: '16-bit BE', grp16LE: '16-bit LE', grp32BE: '32-bit BE', grp32LE: '32-bit LE', grp64BE: '64-bit BE', grp64LE: '64-bit LE',
    write: 'Write', valuePh: 'value', writeErrEmpty: 'Enter a value', writeErrNaN: 'Enter a valid number', writeOk: 'Written',
    noRegisters: 'No registers (import MBS/MBP via API)',
    settingsTitle: 'Settings', settingsSub: 'Appearance, language & data',
    tabLive: 'Live', tabHistory: 'History', tabCurve: 'Curve', tabFirmware: 'Firmware', tabRaw: 'Raw', histTable: 'Table',
    groupCount: '{n} groups',
    newGroup: 'New Group', importPointBook: 'Import points', exportPointBook: 'Export points', editGroup: 'Edit Group', groupName: 'Name', slaveId: 'Slave ID', functionCode: 'Function', startAddress: 'Start addr', quantity: 'Quantity', edit: 'Edit', save: 'Save', fcReadCoils: 'Read Coils', fcReadDiscrete: 'Read Discrete Inputs', fcReadHolding: 'Read Holding', fcReadInput: 'Read Input',
    histHint: 'Last 1 hour', histStart: 'Start', histEnd: 'End', histQuery: 'Query', histLoading: 'Loading…', histPrev: 'Prev', histNext: 'Next', histFirst: 'First', histLast: 'Last', histTotal: '{n} rows', histPage: 'Page {x}/{y}', noHistory: 'No history data', colTime: 'Time', histTruncated: 'Too many rows, showing latest {n}', histIdle: 'Select a time range and click Query', histEmpty: 'No history data in this range', histError: 'Query failed', histRangeInvalid: 'Start time must be before end time', histLast1h: 'Last 1h', histLast6h: 'Last 6h', histLast24h: 'Last 24h', histToday: 'Today', histQuick: 'Quick', selectRegisters: 'Select registers', selectAll: 'Select all', clearAll: 'Clear', histNoRegs: 'No registers selected', curveHint: 'Last 1 hour', curveReset: 'Reset zoom', curveZoomHint: 'Drag top-left→bottom-right to zoom in; drag back to reset', firmwareHint: 'No firmware uploaded yet', fwUpload: 'Upload firmware', fwAbort: 'Abort', fwState: 'State', fwUpgrade: 'Upgrade', fwUploaded: 'Firmware uploaded', fwUploadErr: 'Upload failed', fwStarted: 'Upgrade started', fwUpgradeErr: 'Upgrade failed', fwDelete: 'Delete', fwDeleted: 'Firmware deleted', fwDeleteErr: 'Delete failed', confirmDeleteFirmware: 'Delete firmware {name}?',
    appearance: 'Appearance', themeLabel: 'Theme', light: 'Light', dark: 'Dark', system: 'System',
    language: 'Language',
    appInfo: 'App info', version: 'Version', arch: 'Architecture', persistence: 'Persistence',
    dataMgmt: 'Data management', runLogs: 'Runtime logs', clearLogs: 'Clear logs', logsCleared: 'Logs cleared', retentionLabel: 'Data retention', retentionSaved: 'Retention saved', retentionForever: 'Forever',
    newDeviceTitle: 'New device', editDeviceTitle: 'Edit device', name: 'Name', ip: 'IP address', port: 'Port', transport: 'Transport', transportTcp: 'TCP', transportRtu: 'RTU serial', serialPath: 'Serial path', baudRate: 'Baud rate', parity: 'Parity', stopBits: 'Stop bits', dataBits: 'Data bits', flowControl: 'Flow control', slaveIdLabel: 'Slave ID', pollIntervalLabel: 'Scan interval (ms)', pollIntervalHint: 'Groups poll round-robin; each refreshes roughly every interval × group count', timeoutLabel: 'Timeout (ms)', timeoutHint: 'Read/write request timeout, default 3000 ms', cancel: 'Cancel', add: 'Add',
    importPoints: 'Import points', importTitle: 'Smart point import', importHint: 'Paste CSV (header columns like addr/name/type/enum), or upload CSV/XLSX; JSON array is also accepted.', importPh: 'Paste point-table CSV (header: addr,name,type,enum)', importFile: 'Upload file', importDo: 'Import', importEmpty: 'Enter content or choose a file', impBadJson: 'Cannot parse JSON array', importUpdated: '{n} updated', importSkipped: '{n} skipped', importErrors: 'Errors', importColumns: 'Detected columns',
    tabMonitor: 'Monitor', tabDatabase: 'Database', dbHistory: 'History data', dbTotalRows: 'Total samples', dbTimeSpan: 'Time span', dbDiskUsage: 'Disk usage', dbPerDevice: 'Per device', dbMetadata: 'Metadata', dbRetention: 'Retention', dbRefresh: 'Refresh', dbNoData: 'No history data yet', dbBufferHint: '{n} buffered rows pending flush', dbDevices: 'Devices', dbGroups: 'Groups', dbRegisters: 'Registers', dbRules: 'Alarm rules', dbFirmwares: 'Firmware', dbLogs: 'Logs', dbRetentionForever: 'Forever', dbRetentionDays: '{n} days',
  },
}

async function request(url: string, options?: RequestInit): Promise<any> {
  const r = await fetch(url, options)
  if (!r.ok) {
    let detail = ''
    try { detail = await r.text() } catch { /* ignore */ }
    try { const parsed = JSON.parse(detail); detail = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : detail } catch { /* plain text response */ }
    throw new Error('HTTP ' + r.status + (detail ? ' ' + detail.slice(0, 200) : ''))
  }
  if (r.status === 204) return null
  return r.json()
}

const api = {
  get: (url: string) => request(url),
  post: (url: string, body?: unknown) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  put: (url: string, body: unknown) => request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: (url: string) => request(url, { method: 'DELETE' }),
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 把 UTC ISO 时间戳转成浏览器本地时区的 YYYY-MM-DD HH:mm:ss 字面字符串（带秒），用于历史/数据库展示。 */
function formatLocalTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/** 浏览器本地时区相对 UTC 的偏移分钟数（东八区为 -480），导出时传给后端做本地化。 */
function localTzOffsetMin(): number {
  return -new Date().getTimezoneOffset()
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}

interface RegView { value: string; label: string | null; covered: boolean; invalid: boolean; writable: boolean }

/** 枚举命中时返回 label（仅枚举，不参与系数/偏移/单位）。 */
function enumLabelOf(reg: Register, decoded: number | bigint): string | null {
  const map = parseEnum(reg.enumJson)
  if (!map || typeof decoded === 'bigint' || !Number.isInteger(decoded)) return null
  const label = map[String(decoded)]
  return label != null ? label : null
}

/** 原始值优先显示；枚举命中时追加 " → label" 徽标。 */
function displayRawWithEnum(reg: Register, decoded: number | bigint): string {
  const raw = formatNumber(decoded)
  const label = enumLabelOf(reg, decoded)
  return label != null ? raw + ' → ' + label : raw
}

function areaForFunctionCode(fc: number): string {
  if (fc === 1 || fc === 5 || fc === 15) return 'coil'
  if (fc === 2) return 'discrete-input'
  if (fc === 4) return 'input-register'
  return 'holding-register'
}

/** 按地址顺序合并多字：首字显示合并值、被覆盖字显示 —、数据不足显示 —（不可写）。 */
function buildRegViews(groups: DeviceGroup[], latest: Record<string, LatestValue>, objectId: number): Map<number, RegView> {
  const views = new Map<number, RegView>()
  for (const g of groups) {
    const rawByAddr: Record<number, number> = {}
    const area = areaForFunctionCode(g.functionCode)
    const prefix = `${objectId}:${area}:`
    for (const k of Object.keys(latest)) {
      if (k.startsWith(prefix)) rawByAddr[Number(k.slice(prefix.length))] = latest[k].rawValue
    }
    const regs = [...g.registers].sort((a, b) => a.startAddress - b.startAddress)
    const groupEnd = g.startAddress + g.quantity
    let consumedUpTo = -Infinity
    for (const r of regs) {
      const w = registerWidth(r.dataType)
      const start = r.startAddress
      const end = start + w
      if (start < consumedUpTo) {
        views.set(r.id, { value: '—', label: null, covered: true, invalid: false, writable: false })
        continue
      }
      const words: number[] = []
      for (let a = start; a < end; a++) {
        const wv = rawByAddr[a]
        if (wv === undefined) break
        words.push(wv)
      }
      const enough = words.length === w && end <= groupEnd
      if (!enough) {
        views.set(r.id, { value: '—', label: null, covered: false, invalid: true, writable: false })
        continue
      }
      const isRaw = isHexType(r.dataType) || isBinType(r.dataType)
      const value = formatRegisterValue(r.dataType, words)
      const label = isRaw ? null : enumLabelOf(r, decodeRegister(r.dataType, words))
      views.set(r.id, { value, label, covered: false, invalid: false, writable: !isRaw })
      consumedUpTo = end
    }
  }
  return views
}

function useOperation(t: T) {
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    if (locked.current) return false
    locked.current = true; setBusy(true); setNotice(null)
    try { await action(); setNotice({ error: false, text: t('operationOk') }); return true }
    catch (error) { setNotice({ error: true, text: t('operationFailed') + ': ' + (error instanceof Error ? error.message : String(error)) }); return false }
    finally { locked.current = false; setBusy(false) }
  }
  return { busy, notice, setNotice, run }
}

function Feedback({ operation, t }: { operation: ReturnType<typeof useOperation>; t: T }) {
  if (!operation.notice) return null
  return <div className={'operation-feedback' + (operation.notice.error ? ' error' : '')} role={operation.notice.error ? 'alert' : 'status'}>
    <span>{operation.notice.text}</span><button aria-label={t('dismiss')} onClick={() => operation.setNotice(null)}>×</button>
  </div>
}

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  return now
}

function SidebarResizer({ t }: { t: T }) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null)
  const [width, setWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem('ps-sidebar-width')); return Number.isFinite(saved) && saved >= 220 ? Math.min(460, saved) : 250 }
    catch { return 250 }
  })
  const maximum = () => Math.max(220, Math.min(460, window.innerWidth - 360))
  const applyWidth = (value: number) => {
    const next = Math.round(Math.max(220, Math.min(maximum(), value)))
    handle.current?.parentElement?.style.setProperty('--sidebar-width', `${next}px`)
    return next
  }
  const saveWidth = (value: number) => {
    setWidth(value)
    try { localStorage.setItem('ps-sidebar-width', String(value)) } catch { /* Width remains usable for this session. */ }
  }
  useEffect(() => {
    const sidebar = handle.current?.parentElement
    sidebar?.style.setProperty('--sidebar-width', `${width}px`)
    return () => { sidebar?.classList.remove('is-resizing') }
  }, [width])
  const finish = (cancel = false) => {
    if (!drag.current) return
    const next = cancel ? drag.current.startWidth : drag.current.width
    applyWidth(next)
    drag.current = null
    handle.current?.parentElement?.classList.remove('is-resizing')
    saveWidth(next)
  }
  return <div ref={handle} className="sidebar-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={t('resizeSidebar')} aria-valuemin={220} aria-valuemax={460} aria-valuenow={width} title={t('resizeSidebarHint')}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.focus()
      const startWidth = e.currentTarget.parentElement!.getBoundingClientRect().width
      drag.current = { startX: e.clientX, startWidth, width: startWidth }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.parentElement?.classList.add('is-resizing')
    }}
    onPointerMove={(e) => {
      if (!drag.current) return
      drag.current.width = applyWidth(drag.current.startWidth + e.clientX - drag.current.startX)
      e.currentTarget.setAttribute('aria-valuenow', String(drag.current.width))
    }}
    onPointerUp={(e) => { finish(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
    onDoubleClick={() => saveWidth(applyWidth(250))}
    onKeyDown={(e) => {
      if (e.key === 'Escape') { finish(true); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const current = e.currentTarget.parentElement!.getBoundingClientRect().width
      const next = e.key === 'Home' ? 220 : e.key === 'End' ? maximum() : current + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 40 : 10)
      saveWidth(applyWidth(next))
    }} />
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('ps-theme') as Theme) ?? 'system')
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('ps-lang') as Lang) ?? 'zh')
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceSearch, setDeviceSearch] = useState('')
  const [deviceOrder, setDeviceOrder] = useState<number[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('ps-device-order') ?? '[]')
      return Array.isArray(saved) ? [...new Set(saved.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)))] : []
    } catch { return [] }
  })
  const [sortingDevices, setSortingDevices] = useState(false)
  const [draggedDevice, setDraggedDevice] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 768 || localStorage.getItem('ps-collapsed') === '1')
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [latest, setLatest] = useState<Record<string, LatestValue>>({})
  const [groupErrors, setGroupErrors] = useState<Record<number, string>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [realtime, setRealtime] = useState<{ status: RealtimeStatus; attempt: number }>({ status: 'connecting', attempt: 0 })
  const [deviceConnected, setDeviceConnected] = useState<Record<number, boolean>>({})
  const [view, setView] = useState<'monitor' | 'database' | 'raw'>('monitor')

  const t: T = useCallback((key: string) => I18N[lang][key] ?? key, [lang])
  const operation = useOperation(t)
  const [loadError, setLoadError] = useState(false)
  const selectedIdRef = useRef<number | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  useEffect(() => {
    const apply = () => {
      const r = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', r)
    }
    apply()
    localStorage.setItem('ps-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => { localStorage.setItem('ps-lang', lang) }, [lang])
  useEffect(() => { localStorage.setItem('ps-collapsed', collapsed ? '1' : '0') }, [collapsed])

  const refreshDevices = useCallback(() => {
    api.get('/api/monitor_objects').then((objs: any[]) => {
      setDevices(objs)
      setLoadError(false)
      const map: Record<number, boolean> = {}
      for (const o of objs) if (o && typeof o.id === 'number') map[o.id] = o.connected === true
      setDeviceConnected(map)
    }).catch(() => setLoadError(true))
  }, [])
  const refreshRegisters = useCallback((id: number) => {
    api.get('/api/monitor_objects/' + id + '/groups').then(async (gs: Array<{ id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number }>) => {
      const out: DeviceGroup[] = []
      for (const g of gs) {
        const regs: Register[] = await api.get('/api/groups/' + g.id + '/registers')
        out.push({ id: g.id, name: g.name, slaveId: g.slaveId, functionCode: g.functionCode, startAddress: g.startAddress, quantity: g.quantity, isActive: g.isActive, registers: regs })
      }
      if (selectedIdRef.current === id) { setGroups(out); setLoadError(false) }
    }).catch(() => { if (selectedIdRef.current === id) setLoadError(true) })
  }, [])

  useEffect(() => { refreshDevices() }, [refreshDevices])
  useEffect(() => { setGroups([]); if (selectedId != null) refreshRegisters(selectedId) }, [selectedId, refreshRegisters])
  useEffect(() => {
    const HEARTBEAT_MS = 10_000
    const STALE_MS = 30_000
    const FORCE_RECONNECT_MS = 45_000
    const FALLBACK_MS = 5_000
    let ws: WebSocket | null = null
    let stopped = false
    let attempt = 0
    let lastMessageAt = Date.now()
    let currentStatus: RealtimeStatus = 'connecting'
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const updateStatus = (status: RealtimeStatus, nextAttempt = attempt) => {
      currentStatus = status
      setRealtime({ status, attempt: nextAttempt })
    }
    const mergeObjectSnapshot = (objectId: number, data: Record<string, LatestValue>) => {
      const prefix = objectId + ':'
      setLatest((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) if (key.startsWith(prefix)) delete next[key]
        for (const [address, value] of Object.entries(data)) next[prefix + address] = value
        return next
      })
    }
    const fetchFallback = async () => {
      if (currentStatus === 'connected') return
      const id = selectedIdRef.current
      if (id == null) return
      try { mergeObjectSnapshot(id, await api.get('/api/monitor_objects/' + id + '/latest')) } catch { /* 下轮继续尝试 */ }
    }
    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return
      attempt += 1
      updateStatus(attempt >= 10 ? 'disconnected' : 'reconnecting', attempt)
      const base = Math.min(15_000, 1_000 * 2 ** Math.min(attempt - 1, 4))
      const delay = Math.round(base * (0.8 + Math.random() * 0.4))
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect() }, delay)
    }
    const handleMessage = (event: MessageEvent) => {
      lastMessageAt = Date.now()
      if (currentStatus !== 'connected') updateStatus('connected', 0)
      let msg: any
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (!msg || typeof msg.type !== 'string' || msg.type === 'pong') return
      if (msg.type === 'latest' && msg.data && typeof msg.data === 'object') setLatest(msg.data)
      else if (msg.type === 'poller/result' && Array.isArray(msg.points)) {
        setLatest((prev) => { const next = { ...prev }; for (const p of msg.points) if (p.area) next[p.objectId + ':' + p.area + ':' + p.address] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }; return next })
      }
      else if (msg.type === 'group-error') setGroupErrors((prev) => ({ ...prev, [msg.groupId]: msg.error }))
      else if (msg.type === 'group-ok') setGroupErrors((prev) => { const next = { ...prev }; delete next[msg.groupId]; return next })
      else if (msg.type === 'config/changed') { refreshDevices(); if (selectedIdRef.current != null) refreshRegisters(selectedIdRef.current) }
      else if (msg.type === 'device/status') {
        if (Array.isArray(msg.states)) {
          setDeviceConnected((prev) => { const next = { ...prev }; for (const s of msg.states) if (s && typeof s.objectId === 'number') next[s.objectId] = s.connected === true; return next })
        } else if (typeof msg.objectId === 'number') {
          setDeviceConnected((prev) => ({ ...prev, [msg.objectId]: msg.connected === true }))
        }
      }
      else if (msg.type === 'group-errors' && Array.isArray(msg.errors)) {
        setGroupErrors((prev) => { const next = { ...prev }; for (const e of msg.errors) if (e && typeof e.groupId === 'number') next[e.groupId] = e.error; return next })
      }
    }
    const connect = () => {
      if (stopped) return
      const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://'
      updateStatus(attempt === 0 ? 'connecting' : 'reconnecting', attempt)
      const socket = new WebSocket(protocol + location.host + '/ws')
      ws = socket
      socket.onopen = () => {
        if (ws !== socket) return
        attempt = 0
        lastMessageAt = Date.now()
        updateStatus('connected', 0)
      }
      socket.onmessage = (event) => { if (ws === socket) handleMessage(event) }
      socket.onerror = () => { if (ws === socket) socket.close() }
      socket.onclose = () => { if (ws === socket) { ws = null; scheduleReconnect() } }
    }
    const reconnectNow = () => {
      if (stopped) return
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
      attempt = 0
      if (ws) { const old = ws; ws = null; old.close() }
      connect()
    }

    const heartbeat = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
    }, HEARTBEAT_MS)
    const watchdog = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const idle = Date.now() - lastMessageAt
      if (idle >= FORCE_RECONNECT_MS) ws.close()
      else if (idle >= STALE_MS && currentStatus === 'connected') updateStatus('stale', attempt)
    }, 5_000)
    const fallback = setInterval(() => { void fetchFallback() }, FALLBACK_MS)
    const onOnline = () => reconnectNow()
    const onVisible = () => { if (document.visibilityState === 'visible' && currentStatus !== 'connected') reconnectNow() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(heartbeat); clearInterval(watchdog); clearInterval(fallback)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      if (ws) { const old = ws; ws = null; old.close() }
    }
  }, [refreshDevices, refreshRegisters])

  const addDevice = useCallback(async (f: DeviceFields) => {
    if (!f.name || (f.transport !== 'rtu' && !f.ip)) return
    await api.post('/api/monitor_objects', f)
    setShowAdd(false); refreshDevices(); operation.setNotice({ error: false, text: t('operationOk') })
  }, [refreshDevices])
  const toggleDevice = async (id: number) => { await operation.run(async () => { await api.post('/api/monitor_objects/' + id + '/toggle'); refreshDevices() }) }
  const editDevice = useCallback(async (id: number, f: DeviceFields) => {
    if (!f.name) return
    await api.put('/api/monitor_objects/' + id, f)
    refreshDevices(); operation.setNotice({ error: false, text: t('operationOk') })
  }, [refreshDevices])
  const deleteDevice = async (id: number) => {
    const device = devices.find((d) => d.id === id)
    if (!window.confirm(t('confirmDeleteDevice').replace('{name}', device?.name ?? String(id)))) return
    await operation.run(async () => {
      await api.del('/api/monitor_objects/' + id)
      if (selectedId === id) setSelectedId(null)
      refreshDevices()
    })
  }

  const selected = devices.find((d) => d.id === selectedId) ?? null
  const orderedDevices = useMemo(() => {
    const ranks = new Map(deviceOrder.map((id, index) => [id, index]))
    return [...devices].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
  }, [devices, deviceOrder])
  const visibleDevices = orderedDevices.filter((d) => sortingDevices || `${d.name} ${d.ip}:${d.port} ${d.serialPath ?? ''}`.toLowerCase().includes(deviceSearch.trim().toLowerCase()))
  const moveDevice = (from: number, to: number) => {
    const ids = orderedDevices.map(d => d.id)
    const source = ids.indexOf(from), target = ids.indexOf(to)
    if (source < 0 || target < 0 || source === target) return
    ids.splice(source, 1)
    ids.splice(target, 0, from)
    setDeviceOrder(ids)
    try { localStorage.setItem('ps-device-order', JSON.stringify(ids)) }
    catch { operation.setNotice({ error: true, text: t('orderSaveFailed') }) }
  }

  return (
    <div className={'shell' + (collapsed ? ' nav-collapsed' : '')}>
      {!collapsed && <button className="sidebar-backdrop" aria-label={t('collapseNav')} onClick={() => setCollapsed(true)} />}
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="sidebar-header">
          <div className="sidebar-head-row">
            {!collapsed && (
              <div>
                <div className="brand"><span className="brand-mark" aria-hidden="true">∿</span>{t('brand')}</div>
                <div className="brand-sub">{t('brandSub')}</div>
              </div>
            )}
            <button className="collapse-btn" aria-label={t(collapsed ? 'expandNav' : 'collapseNav')} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '»' : '«'}</button>
          </div>
        </div>
        {!collapsed && (
          <>
            <button className="btn primary new-device-btn" onClick={() => setShowAdd(true)}>＋ {t('newDevice')}</button>
            <input className="device-search" disabled={sortingDevices} aria-label={t('searchDevices')} placeholder={t('searchDevices')} value={deviceSearch} onChange={(e) => setDeviceSearch(e.target.value)} />
            <div className="sidebar-section">{t('devices')} · {devices.length.toString().padStart(2, '0')}<button className="sort-devices-btn" aria-pressed={sortingDevices} onClick={() => { setSortingDevices(!sortingDevices); setDraggedDevice(null); setDropTarget(null) }}>{t(sortingDevices ? 'finishSorting' : 'sortDevices')}</button></div>
            {sortingDevices && <p className="device-sort-hint">{t('sortingHint')}</p>}
            <div className="device-list">
              {visibleDevices.map((d, index) => (
                <div key={d.id} data-device-id={d.id} className={'device-item' + (selectedId === d.id ? ' active' : '') + (draggedDevice === d.id ? ' dragging' : '') + (dropTarget === d.id ? ' drop-target' : '')}>
                {sortingDevices && <span className="device-drag-handle" title={t('dragDevice')} aria-hidden="true"
                  onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDraggedDevice(d.id) }}
                  onPointerMove={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                    const list = e.currentTarget.closest('.device-list')
                    const bounds = list?.getBoundingClientRect()
                    if (list && bounds) { if (e.clientY < bounds.top + 30) list.scrollTop -= 12; else if (e.clientY > bounds.bottom - 30) list.scrollTop += 12 }
                    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-device-id]')
                    setDropTarget(row ? Number(row.getAttribute('data-device-id')) : null)
                  }}
                  onPointerUp={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-device-id]')
                    if (row) moveDevice(d.id, Number(row.getAttribute('data-device-id')))
                    e.currentTarget.releasePointerCapture(e.pointerId); setDraggedDevice(null); setDropTarget(null)
                  }}
                  onPointerCancel={() => { setDraggedDevice(null); setDropTarget(null) }}
                  onLostPointerCapture={() => { setDraggedDevice(null); setDropTarget(null) }}>⠿</span>}
                <button className="device-select" aria-current={selectedId === d.id ? 'page' : undefined} onClick={() => { setSelectedId(d.id); setView('monitor'); if (window.innerWidth <= 768) setCollapsed(true) }}>
                  <span className={'device-dot' + (deviceConnected[d.id] === true ? ' on' : '')} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="device-name">{d.name}</div>
                    <div className="device-sub">{d.transport === 'rtu' ? (d.serialPath || 'RTU') : (d.ip + ':' + d.port)}</div>
                  </div>
                </button>
                  {sortingDevices ? <div className="device-order-actions">
                    <button aria-label={t('moveUp') + ': ' + d.name} title={t('moveUp')} disabled={index === 0} onClick={() => moveDevice(d.id, visibleDevices[index - 1].id)}>↑</button>
                    <button aria-label={t('moveDown') + ': ' + d.name} title={t('moveDown')} disabled={index === visibleDevices.length - 1} onClick={() => moveDevice(d.id, visibleDevices[index + 1].id)}>↓</button>
                  </div> : <button className="device-del" aria-label={t('deleteDevice') + ': ' + d.name} disabled={operation.busy} onClick={() => deleteDevice(d.id)}>×</button>}
                </div>
              ))}
              {devices.length === 0 && <div className="device-sub" style={{ padding: 8 }}>{t('noDevices')}</div>}
              {devices.length > 0 && visibleDevices.length === 0 && <div className="device-sub" style={{ padding: 12 }}>{t('noSearchResults')}</div>}
            </div>
          </>
        )}
        <div className="sidebar-footer">
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <span className="ico">⚙</span>
            {!collapsed && <span>{t('settings')}</span>}
          </button>
        </div>
        {!collapsed && <SidebarResizer t={t} />}
      </aside>

      <main className="main">
        <Feedback operation={operation} t={t} />
        {loadError && <div className="operation-feedback error" role="alert">{t('loadFailed')}<button className="btn" onClick={() => { refreshDevices(); if (selectedId != null) refreshRegisters(selectedId) }}>{t('refresh')}</button></div>}
        <GlobalTabBar t={t} view={view} onChange={setView} />
        {view === 'database'
          ? <DatabaseView t={t} device={selected} />
          : view === 'raw'
            ? <RawDataView t={t} device={selected} />
            : (selected
              ? <DeviceView key={selected.id} t={t} device={selected} connected={deviceConnected[selected.id] === true} groups={groups} latest={latest} groupErrors={groupErrors} realtime={realtime} busy={operation.busy} onToggle={toggleDevice} onEdit={editDevice} onDelete={deleteDevice} onRefresh={refreshRegisters} />
              : <EmptyState t={t} onAdd={() => setShowAdd(true)} />)}
      </main>

      {showAdd && <DeviceModal t={t} initial={null} onClose={() => setShowAdd(false)} onSave={addDevice} />}
      {showSettings && <SettingsModal t={t} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function EmptyState({ t, onAdd }: { t: T; onAdd: () => void }) {
  return <div className="empty-state"><div className="big">🛰️</div><div>{t('emptyHint')}</div><button className="btn primary" onClick={onAdd}>＋ {t('newDevice')}</button></div>
}

function GlobalTabBar({ t, view, onChange }: { t: T; view: 'monitor' | 'database' | 'raw'; onChange: (v: 'monitor' | 'database' | 'raw') => void }) {
  return (
    <div className="global-tab-bar">
      <button className={'global-tab' + (view === 'monitor' ? ' active' : '')} onClick={() => onChange('monitor')}>{t('tabMonitor')}</button>
      <button className={'global-tab' + (view === 'database' ? ' active' : '')} onClick={() => onChange('database')}>{t('tabDatabase')}</button>
      <button className={'global-tab' + (view === 'raw' ? ' active' : '')} onClick={() => onChange('raw')}>{t('tabRaw')}</button>
    </div>
  )
}

function fmtTs(s: string | null | undefined): string {
  if (!s) return '—'
  return formatLocalTs(s)
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return v.toFixed(1) + ' ' + units[i]
}

function DatabaseView({ t, device }: { t: T; device: Device | null }) {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!device) { setStats(null); setErr(null); return }
    setLoading(true); setErr(null)
    try { setStats(await api.get('/api/monitor_objects/' + device.id + '/stats')) } catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setLoading(false) }
  }, [device])
  useEffect(() => { void load() }, [load])

  const retention = stats?.retention?.retention_seconds
  const retentionText = retention === 0 ? t('dbRetentionForever') : (retention != null ? t('dbRetentionDays').replace('{n}', String(Math.round(retention / 86400))) : '—')

  if (!device) {
    return <div className="db-view"><div className="hist-empty">{t('emptyHint')}</div></div>
  }

  return (
    <div className="db-view">
      <div className="db-head">
        <div>
          <div className="db-title">{t('tabDatabase')}</div>
          <div className="kv" style={{ wordBreak: 'break-all' }}>{device.name} · {device.transport === 'rtu' ? (device.serialPath || 'RTU') : (device.ip + ':' + device.port)} · 超时 {device.timeoutMs ?? 3000}ms</div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void load()} disabled={loading}>{loading ? '…' : t('dbRefresh')}</button>
      </div>
      {err && <div className="write-msg error">{err}</div>}

      <div className="db-cards">
        <div className="db-card">
          <div className="db-card-title">{t('dbHistory')}</div>
          <div className="db-big">{stats ? Number(stats.totalRows).toLocaleString() : '—'}</div>
          <div className="kv">{t('dbTotalRows')}</div>
        </div>
        <div className="db-card">
          <div className="db-card-title">{t('dbTimeSpan')}</div>
          <div className="db-big" style={{ fontSize: 20, lineHeight: 1.4 }}>{stats ? fmtTs(stats.oldestTs) + ' → ' + fmtTs(stats.newestTs) : '—'}</div>
        </div>
      </div>

      {stats && stats.bufferPending > 0 && <div className="kv" style={{ marginBottom: 14 }}>{t('dbBufferHint').replace('{n}', String(stats.bufferPending))}</div>}

      <div className="db-section">
        <div className="db-section-title">{t('dbRetention')}</div>
        <div className="kv">{retentionText}</div>
      </div>
    </div>
  )
}

function DeviceView({ t, device, connected, groups, latest, groupErrors, realtime, busy, onToggle, onEdit, onDelete, onRefresh }: {
  t: T; device: Device; connected: boolean; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>
  realtime: { status: RealtimeStatus; attempt: number }
  busy: boolean; onToggle: (id: number) => void; onEdit: (id: number, fields: DeviceFields) => Promise<void>; onDelete: (id: number) => void; onRefresh: (id: number) => void
}) {
  const [tab, setTab] = useState(0)
  const [showEdit, setShowEdit] = useState(false)
  const registers = useMemo(() => groups.flatMap((g) => g.registers), [groups])
  const now = useNow()
  const threshold = staleAfterMs(device.pollIntervalMs ?? 1000, device.timeoutMs ?? 3000, groups)
  const times = groups.flatMap(g => g.registers.map(r => sampleTime(latest[device.id + ':' + areaForFunctionCode(g.functionCode) + ':' + r.startAddress]))).filter((v): v is number => v !== null)
  const lastSample = times.length ? Math.max(...times) : null
  const age = lastSample === null ? null : Math.max(0, Math.floor((now - lastSample) / 1000))
  const realtimeText = realtime.status === 'connected' ? t('realtimeConnected')
    : realtime.status === 'connecting' ? t('realtimeConnecting')
      : realtime.status === 'stale' ? t('realtimeStale')
        : realtime.status === 'reconnecting' ? t('realtimeReconnecting').replace('{n}', String(realtime.attempt))
          : t('realtimeDisconnected')
  return (
    <div className="device-view">
      <div className="section-eyebrow">{t('overview')}</div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive && connected ? ' on' : '')}>{!device.isActive ? t('pausedData') : !groups.some(g => g.isActive) ? t('noActiveGroups') : connected ? t('sampling') : t('connectionPending')}</span>
        {realtime.status === 'connected' && <span className="channel-ok">{realtimeText}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={() => onToggle(device.id)}>{device.isActive ? t('disconnect') : t('connect')}</button>
        <button className="btn" onClick={() => setShowEdit(true)}>{t('edit')}</button>
        <button className="btn danger" disabled={busy} onClick={() => onDelete(device.id)}>{t('deleteDevice')}</button>
      </div>
      <div className="main-sub">Modbus {device.transport.toUpperCase()} · {device.transport === 'rtu' ? (device.serialPath || 'RTU') : (device.ip + ':' + device.port)} · {t('groupCount').replace('{n}', String(groups.length))} · {t('regCount').replace('{n}', String(registers.length))}</div>
      {realtime.status !== 'connected' && <div className="connection-notice" role="status">{t('pageConnection')} <span>{realtimeText}</span></div>}
      <div className="sampling-summary" title={t('ageHint').replace('{n}', String(Math.round(threshold / 1000)))}>
        <span>{t('lastSample')}: <strong>{age === null ? t('notSampled') : t('secondsAgo').replace('{n}', String(age))}</strong></span>
        <span>{lastSample === null ? '—' : formatLocalTs(new Date(lastSample).toISOString())}</span>
        <span className={groups.some(g => groupErrors[g.id]) ? 'has-fault' : ''}>{t('faultsLabel')}: {groups.filter(g => groupErrors[g.id]).length}</span>
      </div>
      <TabBar tabs={[t('tabLive'), t('tabHistory'), t('tabFirmware'), t('liveCurve')]} active={tab} onChange={setTab} />
      {tab === 0 && <LiveTable t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} now={now} threshold={threshold} onRefresh={() => onRefresh(device.id)} />}
      {tab === 1 && <HistoryView t={t} device={device} groups={groups} registers={registers} />}
      {tab === 2 && <FirmwareView t={t} device={device} />}
      <div hidden={tab !== 3}><LiveCurve t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} threshold={threshold} /></div>
      {showEdit && <DeviceModal t={t} initial={device} onClose={() => setShowEdit(false)} onSave={async (f) => { await onEdit(device.id, f); setShowEdit(false) }} />}
    </div>
  )
}

function TabBar({ tabs, active, onChange }: { tabs: string[]; active: number; onChange: (i: number) => void }) {
  return (
    <div className="tab-bar">
      {tabs.map((name, i) => (
        <button key={i} className={'tab' + (active === i ? ' active' : '')} onClick={() => onChange(i)}>{name}</button>
      ))}
    </div>
  )
}

function LiveTable({ t, device, groups, latest, groupErrors, now, threshold, onRefresh }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>; now: number; threshold: number; onRefresh: () => void
}) {
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; group: DeviceGroup }>(null)
  const [writeReg, setWriteReg] = useState<Register | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [search, setSearch] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const operation = useOperation(t)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleCollapse = (id: number) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const deleteGroup = async (id: number) => {
    const g = groups.find((gg) => gg.id === id)
    if (!window.confirm(t('confirmDeleteGroup').replace('{name}', g?.name ?? String(id)))) return
    await operation.run(async () => { await api.del('/api/groups/' + id); onRefresh() })
  }
  const toggleGroupPause = async (id: number) => {
    await operation.run(async () => { await api.post('/api/groups/' + id + '/toggle-pause'); onRefresh() })
  }
  const bookInputRef = useRef<HTMLInputElement>(null)
  const uploadBook = async (e: any) => {
    const file = e?.target?.files?.[0]
    if (!file || !device) return
    await operation.run(async () => {
      const r = await fetch('/api/monitor_objects/' + device.id + '/points/book', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const res = await r.json()
      onRefresh()
      if (res.errors?.length) throw new Error(res.errors.join('; '))
    })
    if (bookInputRef.current) bookInputRef.current.value = ''
  }
  const views = useMemo(() => buildRegViews(groups, latest, device.id), [groups, latest, device.id])
  const health = (g: DeviceGroup, r: Register) => pointHealth(Array.from({ length: registerWidth(r.dataType) }, (_, i) => latest[device.id + ':' + areaForFunctionCode(g.functionCode) + ':' + (r.startAddress + i)]), now, threshold, !device.isActive || !g.isActive, !!groupErrors[g.id])
  // Summarize the full group before applying search or issue filters.
  const summaries = new Map(groups.map(g => {
    const state = pointHealth(Array.from({ length: g.quantity }, (_, i) => latest[device.id + ':' + areaForFunctionCode(g.functionCode) + ':' + (g.startAddress + i)]), now, threshold, !device.isActive || !g.isActive, !!groupErrors[g.id])
    const incomplete = state.missing || g.registers.some(r => views.get(r.id)?.invalid)
    const status = !device.isActive || !g.isActive ? 'pausedData' : groupErrors[g.id] ? 'groupCommunicationError' : state.timestamp === null ? 'notSampled' : incomplete ? 'groupPartialData' : state.stale ? 'groupOldValues' : 'fresh'
    return [g.id, { ...state, status }] as const
  }))
  const shown = groups.map(g => ({ ...g, registers: g.registers.filter(r => {
    const match = (r.alias ?? '').toLowerCase().includes(search.toLowerCase()) || String(r.startAddress).includes(search) || ('0x' + r.startAddress.toString(16)).includes(search.toLowerCase())
    const rv = views.get(r.id)
    return match && (!issuesOnly || (!rv?.covered && (health(g, r).stale || rv?.invalid)))
  }) })).filter(g => g.registers.length > 0 || (!search && !issuesOnly))
  return (
    <div>
      <Feedback operation={operation} t={t} />
      <div className="observation-toolbar">
        <div className="seg"><button className={!configuring ? 'selected' : ''} aria-pressed={!configuring} onClick={() => setConfiguring(false)}>{t('observe')}</button><button className={configuring ? 'selected' : ''} aria-pressed={configuring} onClick={() => setConfiguring(true)}>{t('configure')}</button></div>
        <input className="hist-input point-search" aria-label={t('searchPoints')} placeholder={t('searchPoints')} value={search} onChange={e => setSearch(e.target.value)} />
        <label className="issues-filter"><input type="checkbox" checked={issuesOnly} onChange={e => setIssuesOnly(e.target.checked)} />{t('onlyIssues')}</label>
      </div>
      {configuring && <div className="toolbar">
        <button className="btn primary" onClick={() => setModal({ mode: 'add' })}>＋ {t('newGroup')}</button>
        <button className="btn" disabled={operation.busy} onClick={() => bookInputRef.current?.click()}>⬆ {t('importPointBook')}</button>
        <button className="btn" onClick={() => window.open('/api/monitor_objects/' + device.id + '/points/book')}>⬇ {t('exportPointBook')}</button>
        <input ref={bookInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => void uploadBook(e)} />
      </div>}
      {shown.map((g) => {
        const summary = summaries.get(g.id)!
        return (
        <div key={g.id} className="group-block">
          <div className="group-data-summary">
            <span>{t('pointStatus')}: <strong className={summary.status === 'fresh' ? 'group-data-fresh' : summary.status === 'groupCommunicationError' ? 'has-fault' : ''}>{t(summary.status)}</strong></span>
            <span title={t('groupTimeHint') + (summary.timestamp === null ? '' : ' · ' + formatLocalTs(new Date(summary.timestamp).toISOString()))}>{t('updatedAt')}: <strong>{summary.ageSeconds === null ? '—' : t('secondsAgo').replace('{n}', String(summary.ageSeconds))}</strong></span>
          </div>
          <div className="group-head">
            <button className="group-collapse" onClick={() => toggleCollapse(g.id)}>{collapsed.has(g.id) ? '▸' : '▾'}</button>
            <span className="group-name" style={{ cursor: 'pointer' }} onClick={() => toggleCollapse(g.id)}>{g.name}</span>
            <span className="kv">FC{g.functionCode} · 从站 {g.slaveId} · 起始 {g.startAddress} · {g.quantity} 个</span>
            {groupErrors[g.id] && <span className="group-error" title={groupErrors[g.id]}>⚠ {groupErrors[g.id] === 'Disconnected' ? t('groupDisconnected') : groupErrors[g.id]}</span>}
            <div style={{ flex: 1 }} />
            <button className="btn" disabled={operation.busy} onClick={() => toggleGroupPause(g.id)}>{g.isActive ? t('pause') : t('resume')}</button>
            {configuring && <button className="btn" onClick={() => setModal({ mode: 'edit', group: g })}>{t('edit')}</button>}
            {configuring && <button className="btn danger" disabled={operation.busy} onClick={() => deleteGroup(g.id)}>{t('deleteGroup')}</button>}
          </div>
          {!collapsed.has(g.id) && (<div className="register-table-scroll"><table className="reg">
            <thead><tr><th>{t('colAddr')}</th><th>{t('colAlias')}</th><th>{t('colType')}</th><th>{t('colValue')}</th>{!configuring && <th>{t('write')}</th>}</tr></thead>
            <tbody>
              {g.registers.map((r) => {
                const rv = views.get(r.id)
                const state = health(g, r)
                const writable = rv?.writable && [1, 3].includes(g.functionCode)
                return (
                  <tr key={r.id}>
                    <td className="kv">{r.startAddress}</td>
                    <td>{configuring ? <AliasCell t={t} reg={r} onRefresh={onRefresh} /> : <span>{r.alias || '—'}</span>}</td>
                    <td>{configuring ? <TypeCell t={t} reg={r} available={g.startAddress + g.quantity - r.startAddress} disabled={rv?.covered} onRefresh={onRefresh} /> : <span className="point-type">{r.dataType}</span>}</td>
                    <td className={'value' + (state.stale ? ' stale-value' : '')} title={rv?.covered ? t('valueCovered') : rv?.invalid ? t('valueShort') : t('valueHint')} onDoubleClick={writable ? () => setWriteReg(r) : undefined}>{rv?.value ?? '—'}{rv?.label ? <span className="enum-badge">→ {rv.label}</span> : null}</td>
                    {!configuring && <td>{writable ? <button className="btn" onClick={() => setWriteReg(r)}>{t('write')}</button> : <span className="kv">{[2, 4].includes(g.functionCode) ? t('readOnly') : '—'}</span>}</td>}
                  </tr>
                )
              })}
              {g.registers.length === 0 && <tr><td colSpan={configuring ? 4 : 5} className="kv">{t('noRegisters')}</td></tr>}
            </tbody>
          </table></div>)}
        </div>
      )})}
      {shown.length === 0 && <div className="hist-empty">{t(groups.length === 0 ? 'noRegisters' : 'noMatchingPoints')}</div>}
      {modal && <GroupModal t={t} device={device} initial={modal.mode === 'edit' ? modal.group : null} onClose={() => setModal(null)} onSaved={() => { setModal(null); onRefresh(); operation.setNotice({ error: false, text: t('operationOk') }) }} />}
      {writeReg && <WriteModal t={t} deviceName={device.name} currentValue={views.get(writeReg.id)?.value ?? '—'} reg={writeReg} onClose={() => setWriteReg(null)} onSaved={() => { setWriteReg(null); operation.setNotice({ error: false, text: t('writeOk') }) }} />}
    </div>
  )
}

function GroupModal({ t, device, initial, onClose, onSaved }: {
  t: T; device: Device; initial: DeviceGroup | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [slaveId, setSlaveId] = useState(String(initial?.slaveId ?? 1))
  const [functionCode, setFunctionCode] = useState(String(initial?.functionCode ?? 3))
  const [startAddress, setStartAddress] = useState(String(initial?.startAddress ?? 0))
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1))
  const [isActive, setIsActive] = useState(initial ? initial.isActive === 1 : true)
  const operation = useOperation(t)
  const save = () => operation.run(async () => {
    const body = { name, slaveId: Number(slaveId), functionCode: Number(functionCode), startAddress: Number(startAddress), quantity: Number(quantity), isActive: isActive ? 1 : 0 }
    if (initial) await api.put('/api/groups/' + initial.id, body)
    else await api.post('/api/monitor_objects/' + device.id + '/groups', body)
    onSaved()
  })
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? t('editGroup') : t('newGroup')}</h3>
        <Feedback operation={operation} t={t} />
        <label>{t('groupName')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('slaveId')}</label>
        <input value={slaveId} onChange={(e) => setSlaveId(e.target.value)} />
        <label>{t('functionCode')}</label>
        <select value={functionCode} onChange={(e) => setFunctionCode(e.target.value)}>
          <option value="1">FC01 · {t('fcReadCoils')}</option>
          <option value="2">FC02 · {t('fcReadDiscrete')}</option>
          <option value="3">FC03 · {t('fcReadHolding')}</option>
          <option value="4">FC04 · {t('fcReadInput')}</option>
        </select>
        <label>{t('startAddress')}</label>
        <input value={startAddress} onChange={(e) => setStartAddress(e.target.value)} />
        <label>{t('quantity')}</label>
        <input value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <label className="checkbox-row">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          <span>{t('enable')}</span>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" disabled={operation.busy} onClick={() => void save()}>{operation.busy ? t('working') : t('save')}</button>
        </div>
      </div>
    </div>
  )
}

function WriteModal({ t, reg, deviceName, currentValue, onClose, onSaved }: { t: T; reg: Register; deviceName: string; currentValue: string; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [method, setMethod] = useState<'single' | 'multiple'>('multiple')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const width = registerWidth(reg.dataType)
  const base = baseType(reg.dataType)
  const is64 = base === 'int64' || base === 'uint64'
  const write = async () => {
    if (value.trim() === '') { setErr(t('writeErrEmpty')); return }
    const num = is64 ? value : Number(value)
    if (!is64 && (Number.isNaN(num) || !Number.isFinite(num))) { setErr(t('writeErrNaN')); return }
    setBusy(true); setErr(null)
    try {
      await api.post('/api/registers/' + reg.id + '/write', { value: num, method: width > 1 ? 'multiple' : method })
      setOk(true)
      setTimeout(() => onSaved(), 600)
    } catch (e) {
      setErr((e as any)?.message ?? String(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('writeReg')}</h3>
        <div className="write-context"><strong>{deviceName}</strong><span>{t('currentValue')}: {currentValue}</span><small>{t('pointWriteHint')}</small></div>
        <div className="kv" style={{ marginBottom: 10 }}>{reg.alias ?? reg.id} · {t('colAddr')} {reg.startAddress} · {reg.dataType}{width > 1 ? '（' + width + ' 寄存器）' : ''}</div>
        <label>{t('valuePh')}</label>
        <input value={value} onChange={(e) => { setValue(e.target.value); setErr(null); setOk(false) }} autoFocus placeholder={t('valuePh')} />
        <label>{t('functionCode')}</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'single' | 'multiple')} disabled={width > 1}>
          <option value="multiple">{reg.functionCode === 1 ? 'FC05' : t('fc16')}</option>
          {width === 1 && reg.functionCode !== 1 && <option value="single">{t('fc06')}</option>}
        </select>
        {err && <div className="write-msg error">{err}</div>}
        {ok && <div className="write-msg ok">{t('writeOk')}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={write} disabled={busy || ok}>{ok ? t('writeOk') : t('write')}</button>
        </div>
      </div>
    </div>
  )
}

function AliasCell({ t, reg, onRefresh }: { t: T; reg: Register; onRefresh: () => void }) {
  const [val, setVal] = useState(reg.alias ?? '')
  const operation = useOperation(t)
  useEffect(() => { setVal(reg.alias ?? '') }, [reg.alias])
  const commit = async () => {
    if (val === (reg.alias ?? '')) return
    await operation.run(async () => { await api.put('/api/registers/' + reg.id, { alias: val || null }); onRefresh() })
  }
  return (
    <div className="inline-edit"><input className="cell-input" disabled={operation.busy} value={val} placeholder={t('colAlias')}
      onChange={(e) => setVal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /><Feedback operation={operation} t={t} /></div>
  )
}

function TypeCell({ t, reg, available, disabled, onRefresh }: { t: T; reg: Register; available: number; disabled?: boolean; onRefresh: () => void }) {
  const [err, setErr] = useState(false)
  const operation = useOperation(t)
  const change = async (v: string) => {
    if (v === reg.dataType) return
    if (registerWidth(v) > available) { setErr(true); setTimeout(() => setErr(false), 1600); return }
    await operation.run(async () => { await api.put('/api/registers/' + reg.id, { dataType: v }); onRefresh() })
  }
  return (
    <div className="inline-edit">
      <select className="cell-select" value={reg.dataType} onChange={(e) => change(e.target.value)} disabled={disabled || operation.busy}>
        {TYPE_GROUPS.map((grp) => (
          <optgroup key={grp.key} label={t(grp.key)}>
            {grp.types.map((d) => <option key={d} value={d}>{d}</option>)}
          </optgroup>
        ))}
      </select>
      {err && <span className="cell-err" title={t('valueShort')}>⚠</span>}
      <Feedback operation={operation} t={t} />
    </div>
  )
}


function useRegisterSelection(deviceId: number, registers: Register[]): [Set<number>, (s: Set<number>) => void] {
  const key = 'ps-regs-' + deviceId
  const [ids, setIds] = useState<Set<number> | null>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return null
      const saved: unknown = JSON.parse(raw)
      return Array.isArray(saved) ? new Set(saved.filter((id): id is number => typeof id === 'number')) : null
    } catch { return null }
  })
  const selected = useMemo(() => new Set(registers.filter(r => ids === null || ids.has(r.id)).map(r => r.id)), [ids, registers])
  const update = useCallback((next: Set<number>) => {
    setIds(next)
    try { localStorage.setItem(key, JSON.stringify([...next])) } catch { /* Selection remains available this session. */ }
  }, [key])
  return [selected, update]
}

function RegisterSelectModal({ t, groups, initial, onClose, onApply, max }: {
  t: T; groups: DeviceGroup[]; initial: Set<number>; onClose: () => void; onApply: (s: Set<number>) => void; max?: number
}) {
  const [draft, setDraft] = useState<Set<number>>(() => new Set(initial))
  const toggle = (id: number) => setDraft((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const allIds = groups.flatMap(g => g.registers).map(r => r.id)
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal reg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('selectRegisters')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="reg-modal-actions">
          <button className="btn" onClick={() => setDraft(new Set(allIds.slice(0, max)))}>{t('selectAll')}</button>
          <button className="btn" onClick={() => setDraft(new Set())}>{t('clearAll')}</button>
        </div>
        {max && <p className="chart-hint">{t('curveSelectLimit').replace('{n}', String(max))}</p>}
        <div className="reg-list">
          {groups.map(g => (
            <div key={g.id} className="reg-group">
              <div className="reg-group-name">{g.name}</div>
              {g.registers.map(r => (
                <label key={r.id} className="reg-item">
                  <input type="checkbox" checked={draft.has(r.id)} disabled={!draft.has(r.id) && max !== undefined && draft.size >= max} onChange={() => toggle(r.id)} />
                  <span className="reg-item-alias">{r.alias ?? ('reg' + r.id)}</span>
                  <span className="kv">{r.startAddress} · {r.dataType}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => onApply(draft)}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

function RegisterSelectButton({ t, groups, selected, onApply, max }: {
  t: T; groups: DeviceGroup[]; selected: Set<number>; onApply: (s: Set<number>) => void; max?: number
}) {
  const [show, setShow] = useState(false)
  const total = groups.reduce((n, g) => n + g.registers.length, 0)
  return (
    <>
      <button className="btn" onClick={() => setShow(true)}>{t('selectRegisters')} ({selected.size}/{total})</button>
      {show && <RegisterSelectModal t={t} groups={groups} max={max} initial={selected} onClose={() => setShow(false)} onApply={(s) => { onApply(s); setShow(false) }} />}
    </>
  )
}

function deriveHistoryRows(pts: Array<{ ts: string; area: string; address: number; rawValue: number }>, registers: Register[], selectedRegisters: Register[]): Array<{ ts: string; values: Record<number, string> }> {
  const rawByTs = new Map<string, Map<string, Record<number, number>>>()
  for (const p of pts) {
    if (!rawByTs.has(p.ts)) rawByTs.set(p.ts, new Map())
    const area = p.area
    const byArea = rawByTs.get(p.ts)!
    if (!byArea.has(area)) byArea.set(area, {})
    byArea.get(area)![p.address] = p.rawValue
  }
  const nextRows: Array<{ ts: string; values: Record<number, string> }> = []
  for (const [ts, byArea] of rawByTs) {
    const formatted = new Map<number, string>()
    for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) {
      const subset = registers.filter(r => areaForFunctionCode(r.functionCode) === area)
      const raw = byArea.get(area) ?? {}
      const decoded = decodeRawByAddr(subset, raw)
      const rawText = formatRawByAddr(subset, raw)
      for (const r of subset) {
        if (isHexType(r.dataType) || isBinType(r.dataType)) { formatted.set(r.id, rawText.get(r.id) ?? '—'); continue }
        const d = decoded.get(r.id)
        formatted.set(r.id, d == null ? '—' : displayRawWithEnum(r, d))
      }
    }
    const values: Record<number, string> = {}
    for (const r of selectedRegisters) values[r.id] = formatted.get(r.id) ?? '—'
    nextRows.push({ ts, values })
  }
  return nextRows
}

function HistoryView({ t, device, groups, registers }: { t: T; device: Device; groups: DeviceGroup[]; registers: Register[] }) {
  const localInput = (date: Date) => toLocalInput(date) + ':' + String(date.getSeconds()).padStart(2, '0')
  const [mode, setMode] = useState<'table' | 'chart'>('table')
  const [range, setRange] = useState(() => ({ start: localInput(new Date(Date.now() - 3600_000)), end: localInput(new Date()) }))
  const [preset, setPreset] = useState<number | null>(60)
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<{ points: HistoryPoint[]; total: number; start: string; end: string; mode: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [selected, setSelected] = useRegisterSelection(device.id, registers)
  const selectedRegisters = registers.filter(r => selected.has(r.id))
  const startMs = Date.parse(range.start), endMs = Date.parse(range.end)
  const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs
  useEffect(() => {
    if (!valid) return
    const controller = new AbortController()
    setStatus('loading'); setError(null)
    const timer = setTimeout(async () => {
      try {
        const start = new Date(startMs).toISOString(), end = new Date(endMs).toISOString()
        const path = mode === 'chart' ? 'curve' : 'page'
        const response = await request(`/api/data/object/${path}?object_id=${device.id}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page=${page}&page_size=200&max_points=1200`, { signal: controller.signal })
        if (controller.signal.aborted) return
        const points: HistoryPoint[] = response.points ?? response
        setData({ points, total: response.total ?? points.length, start, end, mode }); setStatus('done')
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : String(e)); setStatus('error') }
      }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [device.id, startMs, endMs, valid, mode, page, refresh])
  const changeRange = (start: string, end: string) => { setRange({ start, end }); setPage(0) }
  const applyPreset = (minutes: number) => {
    const now = new Date()
    const start = minutes === 0 ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime() - minutes * 60_000)
    setPreset(minutes); changeRange(localInput(start), localInput(now)); setRefresh(v => v + 1)
  }
  const rows = useMemo(() => deriveHistoryRows(data?.points ?? [], registers, selectedRegisters), [data, registers, selected])
  const doExport = (format: 'csv' | 'xlsx') => {
    if (!valid) return
    const ids = selectedRegisters.map(r => r.id).join(',')
    window.open('/api/export/' + format + '?object_id=' + device.id + '&start=' + new Date(startMs).toISOString() + '&end=' + new Date(endMs).toISOString() + '&tz=' + localTzOffsetMin() + (ids ? '&register_ids=' + ids : ''))
  }
  const currentStatus = data && (data.mode !== mode || Date.parse(data.start) !== startMs || Date.parse(data.end) !== endMs) && status === 'done' ? 'loading' : status
  return <div className="history-view">
    <div className="toolbar">
      <div className="seg"><button className={mode === 'table' ? 'selected' : ''} onClick={() => { setMode('table'); setPage(0) }}>{t('histTable')}</button><button className={mode === 'chart' ? 'selected' : ''} onClick={() => { setMode('chart'); setPage(0) }}>{t('tabCurve')}</button></div>
      <RegisterSelectButton t={t} groups={groups} selected={selected} onApply={setSelected} />
      <div style={{ flex: 1 }} />
      <button className="btn" disabled={!valid || selected.size === 0} onClick={() => setShowExport(true)}>{t('export')}</button>
    </div>
    <div className="hist-quick history-presets">
      {[5, 30, 60, 360, 1440, 0].map(minutes => <button key={minutes} className={'btn' + (preset === minutes ? ' selected' : '')} onClick={() => applyPreset(minutes)}>{minutes === 0 ? t('histToday') : minutes < 60 ? t('histMinutes').replace('{n}', String(minutes)) : t('histHours').replace('{n}', String(minutes / 60))}</button>)}
    </div>
    <div className="toolbar history-range">
      <label className="hist-label">{t('histStart')}<input className="hist-input" type="datetime-local" step="1" value={range.start} onChange={e => { setPreset(null); changeRange(e.target.value, range.end) }} /></label>
      <label className="hist-label">{t('histEnd')}<input className="hist-input" type="datetime-local" step="1" value={range.end} onChange={e => { setPreset(null); changeRange(range.start, e.target.value) }} /></label>
      <button className="btn primary" disabled={!valid || currentStatus === 'loading'} onClick={() => setRefresh(v => v + 1)}>{t(currentStatus === 'loading' ? 'histLoading' : 'histQuery')}</button>
    </div>
    {!valid ? <div className="hist-empty warn">{t('histRangeInvalid')}</div> : mode === 'chart' ? <ChartBody t={t} registers={registers} selected={selected} pts={data?.points ?? []} status={currentStatus} error={error} range={{ start: startMs, end: endMs }} onQueryRange={(start, end) => { setPreset(null); changeRange(localInput(new Date(start)), localInput(new Date(end))); setRefresh(v => v + 1) }} /> : <>
      {currentStatus === 'loading' && <div className="hist-empty" role="status">{t('histLoading')}</div>}
      <HistoryTableBody t={t} rows={rows} selectedRegisters={selectedRegisters} status={currentStatus} error={error} page={page} total={data?.total ?? 0} pageSize={200} onPageChange={setPage} />
    </>}
    {showExport && <ExportModal t={t} onClose={() => setShowExport(false)} onPick={format => { doExport(format); setShowExport(false) }} />}
  </div>
}

function HistoryTableBody({ t, rows, selectedRegisters, status, error, page, total, pageSize, onPageChange }: { t: T; rows: Array<{ ts: string; values: Record<number, string> }>; selectedRegisters: Register[]; status: 'idle' | 'loading' | 'done' | 'error'; error: string | null; page: number; total: number; pageSize: number; onPageChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(0, page), totalPages - 1)
  const shown = rows

  return (
    <>
      {status === 'idle' && <div className="hist-empty">{t('histIdle')}</div>}
      {status === 'done' && rows.length === 0 && <div className="hist-empty">{t('histEmpty')}</div>}
      {status === 'error' && <div className="hist-empty warn">{t('histError')} {error}</div>}
      {status === 'done' && rows.length > 0 && (selectedRegisters.length === 0 ? (
        <div className="hist-empty">{t('histNoRegs')}</div>
      ) : (
        <>
          <table className="reg hist-table">
            <thead><tr><th>{t('colTime')}</th>{selectedRegisters.map(r => <th key={r.id}>{r.alias ?? r.id}</th>)}</tr></thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={i}><td className="kv" title={row.ts}>{formatLocalTs(row.ts)}</td>{selectedRegisters.map(r => <td key={r.id} className="value">{row.values[r.id] ?? '—'}</td>)}</tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span className="kv">{t('histTotal').replace('{n}', String(total))}</span>
            <button className="btn" onClick={() => onPageChange(0)} disabled={currentPage <= 0}>{t('histFirst')}</button>
            <button className="btn" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 0}>{t('histPrev')}</button>
            <span className="kv">{t('histPage').replace('{x}', String(currentPage + 1)).replace('{y}', String(totalPages))}</span>
            <button className="btn" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages - 1}>{t('histNext')}</button>
            <button className="btn" onClick={() => onPageChange(totalPages - 1)} disabled={currentPage >= totalPages - 1}>{t('histLast')}</button>
          </div>
        </>
      ))}
    </>
  )
}

function ExportModal({ t, onClose, onPick }: { t: T; onClose: () => void; onPick: (fmt: 'csv' | 'xlsx') => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('exportTitle')}</h3>
        <div className="export-options">
          <button className="btn primary" onClick={() => onPick('csv')}>{t('exportCsv')}</button>
          <button className="btn primary" onClick={() => onPick('xlsx')}>{t('exportXlsx')}</button>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  )
}

const CHART_COLORS = ['#4176e6', '#22c55e', '#f59e0b', '#ec1313', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6']
function niceStep(range: number, target: number): number {
  const rough = range / target
  const pow = 10 ** Math.floor(Math.log10(rough))
  const n = rough / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}
function yTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min]
  const step = niceStep(max - min, count)
  const start = Math.ceil(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Number((start + i * step).toFixed(10)))
  return out
}
function tickNum(v: number): string {
  const r = Math.abs(v) < 1e-9 ? 0 : v
  if (Number.isInteger(r)) return String(r)
  const a = Math.abs(r)
  if (a !== 0 && (a >= 100000 || a < 0.001)) return r.toExponential(1)
  return String(Number(r.toFixed(2)))
}
function timeTicks(min: number, max: number, count = 6): number[] {
  if (min === max) return [min]
  const range = max - min
  const steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 180000, 240000, 300000, 600000, 900000, 1200000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000, 172800000, 604800000]
  const step = steps.find(s => range / s <= count) ?? 86400000
  const start = Math.ceil(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(start + i * step)
  return out
}
function tickTime(ts: number, span: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  if (span >= 86400000) return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}


function LiveCurve({ t, device, groups, latest, groupErrors, threshold }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>; threshold: number
}) {
  const numericGroups = useMemo(() => groups.map(g => {
    let end = -1
    return { ...g, registers: [...g.registers].sort((a, b) => a.startAddress - b.startAddress).filter(r => {
      if (r.startAddress < end) return false
      end = r.startAddress + registerWidth(r.dataType)
      return end <= g.startAddress + g.quantity && !isHexType(r.dataType) && !isBinType(r.dataType)
    }) }
  }), [groups])
  const candidates = numericGroups.flatMap(g => g.registers)
  const [selection, setSelection] = useState<Set<number> | null>(null)
  const chosen = candidates.filter(r => selection === null || selection.has(r.id)).slice(0, selection === null ? 4 : 8)
  const selected = new Set(chosen.map(r => r.id))
  const [seconds, setSeconds] = useState(60)
  const [frame, setFrame] = useState<{ buffer: CurveBuffer; now: number }>({ buffer: {}, now: Date.now() })
  const [frozen, setFrozen] = useState<typeof frame | null>(null)
  const buffer = useRef<CurveBuffer>({})
  const inputs = useRef({ chosen, latest, device, groups, groupErrors, threshold })
  inputs.current = { chosen, latest, device, groups, groupErrors, threshold }
  useEffect(() => {
    const timer = setInterval(() => {
      const input = inputs.current
      const blocked = new Set(input.groups.filter(g => !input.device.isActive || !g.isActive || input.groupErrors[g.id]).flatMap(g => g.registers.map(r => r.id)))
      const now = Date.now()
      buffer.current = sampleCurve(buffer.current, input.chosen, input.latest, input.device.id, now, input.threshold, blocked)
      setFrame({ buffer: buffer.current, now })
    }, 250)
    return () => clearInterval(timer)
  }, [])
  const visible = frozen ?? frame
  const endTime = visible.now, startTime = endTime - seconds * 1000
  const [size, setSize] = useState({ w: 800, h: 360 })
  const observer = useRef<ResizeObserver | null>(null)
  const setPlot = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!el) return
    const measure = () => { if (el.clientWidth > 0) setSize({ w: el.clientWidth, h: el.clientHeight }) }
    measure(); observer.current = new ResizeObserver(measure); observer.current.observe(el)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  const [hover, setHover] = useState<number | null>(null)
  const series = chosen.map(r => ({ r, color: CHART_COLORS[Math.abs(r.id) % CHART_COLORS.length], points: (visible.buffer[r.id]?.points ?? []).filter(p => p[0] >= startTime && p[0] <= endTime) }))
  let low = Infinity, high = -Infinity
  for (const s of series) for (const [, v] of s.points) if (v !== null) { low = Math.min(low, v); high = Math.max(high, v) }
  const hasData = Number.isFinite(low) && Number.isFinite(high)
  if (!hasData) { low = 0; high = 1 }
  const pad = low === high ? Math.max(1, Math.abs(low) * .05) : (high - low) * .08
  low -= pad; high += pad
  const left = 70, top = 16, bottom = 32, right = 16
  const plotWidth = Math.max(1, size.w - left - right), plotHeight = Math.max(1, size.h - top - bottom)
  const x = (time: number) => left + (time - startTime) / (endTime - startTime) * plotWidth
  const y = (value: number) => top + (high - value) / (high - low) * plotHeight
  const pathFor = (points: Array<[number, number | null]>) => {
    let path = '', previous: number | null = null
    for (const [time, value] of points) {
      if (value === null) { previous = null; continue }
      path += `${previous === null || time - previous > threshold ? 'M' : 'L'}${x(time).toFixed(2)},${y(value).toFixed(2)} `
      previous = time
    }
    return path
  }
  const cursorTime = hover === null ? null : startTime + hover * (endTime - startTime)
  const clear = () => {
    buffer.current = Object.fromEntries(Object.entries(buffer.current).map(([id, track]) => [id, { ...track, points: [] }]))
    setFrame({ buffer: buffer.current, now: Date.now() }); setFrozen(null); setHover(null)
  }
  return <div className="live-curve-view">
    <div className="toolbar">
      <RegisterSelectButton t={t} groups={numericGroups} selected={selected} max={8} onApply={ids => { setSelection(ids); setFrozen(null); setHover(null) }} />
      <label className="live-window-label">{t('liveWindow')}<select className="hist-input" value={seconds} onChange={e => { setSeconds(Number(e.target.value)); setHover(null) }}>{[30, 60, 300, 600].map(n => <option key={n} value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>)}</select></label>
      <button className="btn" onClick={() => { setFrozen(frozen ? null : frame); setHover(null) }}>{t(frozen ? 'resumeCurve' : 'freezeCurve')}</button>
      <button className="btn" onClick={clear}>{t('clearCurve')}</button>
      <span className={'status-badge' + (!frozen ? ' on' : '')}>{t(frozen ? 'curvePaused' : 'curveTracking')}</span>
    </div>
    <p className="chart-hint">{t('liveCurveHint')}</p>
    <div className="chart-wrap">
      <div className="live-curve-plot" ref={setPlot}>
        <svg width="100%" height="100%" role="img" aria-label={t('liveCurve')}
          onMouseMove={e => { const rect = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(1, (e.clientX - rect.left - left) / plotWidth))) }} onMouseLeave={() => setHover(null)}>
          {yTicks(low, high, 5).map(v => <g key={v}><line x1={left} x2={size.w - right} y1={y(v)} y2={y(v)} stroke="var(--border-1)" /><text x={left - 9} y={y(v) + 4} textAnchor="end" fill="var(--text-3)" fontSize={11}>{tickNum(v)}</text></g>)}
          {timeTicks(startTime, endTime, Math.max(2, Math.floor(plotWidth / 110))).map(time => <text key={time} x={x(time)} y={size.h - 9} textAnchor="middle" fill="var(--text-3)" fontSize={11}>{tickTime(time, endTime - startTime)}</text>)}
          {series.map(s => <g key={s.r.id}><path data-live-series={s.r.id} d={pathFor(s.points)} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" />{s.points.length === 1 && s.points[0][1] !== null && <circle cx={x(s.points[0][0])} cy={y(s.points[0][1])} r={3} fill={s.color} />}</g>)}
          {cursorTime !== null && <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={size.h - bottom} stroke="var(--text-3)" strokeDasharray="4 4" />}
        </svg>
        {(!hasData || chosen.length === 0) && <div className="live-curve-empty">{t(candidates.length === 0 ? 'curveNoNumeric' : chosen.length === 0 ? 'histNoRegs' : 'curveWaiting')}</div>}
      </div>
      <div className="live-curve-legend">
        {cursorTime !== null && <span className="point-time">{t('curveTime')}: {tickTime(cursorTime, seconds * 1000)}</span>}
        {series.map(s => {
          const at = cursorTime ?? endTime
          let sample: [number, number | null] | undefined
          for (const p of s.points) if (p[0] <= at) sample = p
          const value = sample && at - sample[0] <= threshold ? sample[1] : null
          return <span key={s.r.id} className="live-legend-value"><i style={{ background: s.color }} /><span>{s.r.alias || `#${s.r.startAddress}`} <small>({s.r.startAddress})</small></span><strong>{value == null ? '—' : formatNumber(value)}</strong></span>
        })}
      </div>
    </div>
    <p className="chart-hint live-curve-footnote">{t('liveRawHint')}</p>
  </div>
}

function ChartBody({ t, registers, selected, pts, status, error, range, onQueryRange }: {
  t: T; registers: Register[]; selected: Set<number>; pts: HistoryPoint[]; status: 'idle' | 'loading' | 'done' | 'error'; error: string | null
  range: { start: number; end: number }; onQueryRange: (start: number, end: number) => void
}) {
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const [yView, setYView] = useState<{ min: number; max: number } | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [relative, setRelative] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ start: number; end: number; fromY: number; toY: number } | null>(null)
  const dragRef = useRef<typeof drag>(null)
  const [size, setSize] = useState({ w: 800, h: 380 })
  const observer = useRef<ResizeObserver | null>(null)
  const clipId = useId()
  const series = useMemo(() => decodeHistorySeries(registers, pts, selected), [registers, pts, selected])
  useEffect(() => { setView(null); setYView(null); setHover(null); setDrag(null); dragRef.current = null }, [pts, range.start, range.end])
  const setPlot = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!el) return
    const measure = () => { if (el.clientWidth) setSize({ w: el.clientWidth, h: el.clientHeight }) }
    measure(); observer.current = new ResizeObserver(measure); observer.current.observe(el)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  const start = view?.start ?? range.start, end = view?.end ?? range.end
  const span = Math.max(1, end - start)
  const L = 72, R = 18, T = 16, B = 34
  const pw = Math.max(1, size.w - L - R), ph = Math.max(1, size.h - T - B)
  const x = (time: number) => L + (time - start) / span * pw
  const visibleSeries = series.map(s => {
    const samples = s.samples.filter(p => p[0] >= start && p[0] <= end)
    let min = Infinity, max = -Infinity, last: number | null = null
    for (const [, v] of samples) if (v !== null) { min = Math.min(min, v); max = Math.max(max, v); last = v }
    return { ...s, samples, min, max, last, color: CHART_COLORS[Math.abs(s.id) % CHART_COLORS.length] }
  })
  let minimum = Infinity, maximum = -Infinity
  for (const s of visibleSeries) if (!hidden.has(s.id)) { minimum = Math.min(minimum, s.min); maximum = Math.max(maximum, s.max) }
  const anyVisible = Number.isFinite(minimum) && Number.isFinite(maximum)
  if (!anyVisible) { minimum = 0; maximum = 1 }
  const pad = minimum === maximum ? Math.max(1, Math.abs(minimum) * .05) : (maximum - minimum) * .08
  const yMin = yView?.min ?? (relative ? 0 : minimum - pad), yMax = yView?.max ?? (relative ? 100 : maximum + pad)
  const ySpan = yMax - yMin
  const adjustY = (scale: number, move = 0) => {
    const center = yMin + ySpan * (.5 + move), half = ySpan * scale / 2
    const min = center - half, max = center + half
    if (Number.isFinite(min) && Number.isFinite(max) && max - min > Math.max(1, Math.abs(center)) * Number.EPSILON * 16) setYView({ min, max })
    setHover(null)
  }
  const y = (value: number) => T + (yMax - value) / (yMax - yMin) * ph
  const displayValue = (value: number, s: typeof visibleSeries[number]) => relative ? s.max === s.min ? 50 : (value - s.min) / (s.max - s.min) * 100 : value
  const pathFor = (s: typeof visibleSeries[number]) => {
    let path = '', previous: number | null = null
    for (const [time, value] of s.samples) {
      if (value === null) { previous = null; continue }
      path += `${previous === null || time - previous > s.gapMs ? 'M' : 'L'}${x(time).toFixed(2)},${y(displayValue(value, s)).toFixed(2)} `
      previous = time
    }
    return path
  }
  const focusRange = (center: number, width: number) => {
    const clampedWidth = Math.min(range.end - range.start, Math.max(1000, width))
    const left = Math.max(range.start, Math.min(range.end - clampedWidth, center - clampedWidth / 2))
    setView({ start: left, end: left + clampedWidth }); setHover(null)
  }
  const pointerTime = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return start + Math.max(0, Math.min(1, (e.clientX - rect.left - L) / pw)) * span
  }
  const pointerValue = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return yMax - Math.max(0, Math.min(1, (e.clientY - rect.top - T) / ph)) * ySpan
  }
  const tooltipRows = hover === null ? [] : visibleSeries.filter(s => !hidden.has(s.id)).map(s => ({ ...s, point: nearestHistorySample(s.samples, hover) }))
  if (status === 'loading') return <div className="hist-empty" role="status">{t('histLoading')}</div>
  if (status === 'error') return <div className="hist-empty warn" role="alert">{t('histError')}: {error}</div>
  if (selected.size === 0) return <div className="hist-empty">{t('histNoRegs')}</div>
  if (!pts.length) return <div className="hist-empty">{t('histEmpty')}</div>
  if (!series.length) return <div className="hist-empty">{t('histNoNumeric')}</div>
  return <div className="chart-wrap history-chart">
    <div className="toolbar history-chart-tools">
      <button className="btn" onClick={() => focusRange((start + end) / 2, span / 2)} disabled={span <= 1000}>{t('histZoomIn')}</button>
      <button className="btn" onClick={() => focusRange((start + end) / 2, span * 2)} disabled={!view}>{t('histZoomOut')}</button>
      <button className="btn" aria-label={t('histMoveEarlier')} onClick={() => focusRange((start + end) / 2 - span / 2, span)} disabled={!view || start <= range.start}>←</button>
      <button className="btn" aria-label={t('histMoveLater')} onClick={() => focusRange((start + end) / 2 + span / 2, span)} disabled={!view || end >= range.end}>→</button>
      <button className="btn" onClick={() => adjustY(.5)}>Y 轴放大</button>
      <button className="btn" onClick={() => adjustY(2)}>Y 轴缩小</button>
      <button className="btn" aria-label="向上移动数值范围" onClick={() => adjustY(1, .5)}>↑</button>
      <button className="btn" aria-label="向下移动数值范围" onClick={() => adjustY(1, -.5)}>↓</button>
      <button className="btn" onClick={() => { setYView(null); setHover(null) }} disabled={!yView}>Y 轴自适应</button>
      <button className="btn" onClick={() => { setView(null); setYView(null); setHover(null) }} disabled={!view && !yView}>{t('curveReset')}</button>
      {view && <button className="btn primary" onClick={() => onQueryRange(start, end)}>{t('histQueryZoom')}</button>}
      <label className="issues-filter"><input type="checkbox" checked={relative} onChange={e => { setRelative(e.target.checked); setYView(null) }} />{t('histRelative')}</label>
    </div>
    <p className="chart-hint">悬停查看读数 · 横向拖动放大时间，纵向拖动放大 Y 轴，斜向框选同时放大两轴 · 双击恢复全范围</p>
    <div className="history-chart-range">{formatLocalTs(new Date(start).toISOString())} — {formatLocalTs(new Date(end).toISOString())}</div>
    <div className="history-chart-plot" ref={setPlot}>
      <svg width="100%" height="100%" role="img" aria-label={t('tabCurve')} style={{ touchAction: 'none' }}
        onPointerDown={e => { if (e.button !== 0) return; const time = pointerTime(e), value = pointerValue(e); dragRef.current = { start: time, end: time, fromY: value, toY: value }; setDrag(dragRef.current); setHover(null); e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { const time = pointerTime(e); if (dragRef.current) { dragRef.current.end = time; dragRef.current.toY = pointerValue(e); setDrag({ ...dragRef.current }) } else setHover(time) }}
        onPointerUp={e => {
          const selection = dragRef.current
          dragRef.current = null; setDrag(null)
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          if (selection) {
            selection.end = pointerTime(e); selection.toY = pointerValue(e)
            const zoomX = Math.abs(selection.end - selection.start) / span * pw > 8
            const zoomY = Math.abs(selection.toY - selection.fromY) / ySpan * ph > 8
            if (zoomX) focusRange((selection.start + selection.end) / 2, Math.abs(selection.end - selection.start))
            if (zoomY) setYView({ min: Math.min(selection.fromY, selection.toY), max: Math.max(selection.fromY, selection.toY) })
            if (!zoomX && !zoomY) setHover(pointerTime(e))
          }
        }}
        onPointerCancel={() => { dragRef.current = null; setDrag(null) }}
        onLostPointerCapture={() => { dragRef.current = null; setDrag(null) }}
        onPointerLeave={() => { if (!dragRef.current) setHover(null) }}
        onDoubleClick={() => { setView(null); setYView(null); setHover(null) }}>
        <defs><clipPath id={clipId}><rect x={L} y={T} width={pw} height={ph} /></clipPath></defs>
        {yTicks(yMin, yMax, 5).map(value => <g key={value}><line x1={L} x2={size.w - R} y1={y(value)} y2={y(value)} stroke="var(--border-1)" /><text x={L - 8} y={y(value) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">{tickNum(value)}{relative ? '%' : ''}</text></g>)}
        {timeTicks(start, end, Math.max(2, Math.floor(pw / 110))).map(time => <text key={time} x={x(time)} y={size.h - 10} textAnchor="middle" fontSize={11} fill="var(--text-3)">{tickTime(time, span)}</text>)}
        <g clipPath={`url(#${clipId})`}>
          {visibleSeries.filter(s => !hidden.has(s.id)).map(s => <g key={s.id}><path data-history-series={s.id} d={pathFor(s)} stroke={s.color} fill="none" strokeWidth={1.8} />{s.samples.filter(p => p[1] !== null).length <= 1 && s.samples.filter((p): p is [number, number] => p[1] !== null).map(p => <circle key={p[0]} cx={x(p[0])} cy={y(displayValue(p[1], s))} r={3} fill={s.color} />)}</g>)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={size.h - B} stroke="var(--text-3)" strokeDasharray="4 4" />}
          {drag && <rect className="zoom-box" x={Math.abs(x(drag.end) - x(drag.start)) > 8 ? x(Math.min(drag.start, drag.end)) : L} y={Math.abs(y(drag.toY) - y(drag.fromY)) > 8 ? y(Math.max(drag.fromY, drag.toY)) : T} width={Math.abs(x(drag.end) - x(drag.start)) > 8 ? Math.abs(x(drag.end) - x(drag.start)) : pw} height={Math.abs(y(drag.toY) - y(drag.fromY)) > 8 ? Math.abs(y(drag.toY) - y(drag.fromY)) : ph} />}
        </g>
      </svg>
      {!anyVisible && <div className="live-curve-empty">{t('histNoVisible')}</div>}
      {hover !== null && !drag && <div className="history-tooltip" style={{ left: Math.max(4, Math.min(size.w - 265, x(hover) + 12)) }}>
        <strong>{t('histNearest')}</strong>
        {tooltipRows.map(s => { const reg = registers.find(r => r.id === s.id); const point = s.point; const valid = point && Math.abs(point[0] - hover) <= s.gapMs / 2; return <div key={s.id}><span style={{ color: s.color }}>{reg?.alias || `#${reg?.startAddress ?? s.id}`}</span><b>{valid && point[1] !== null ? formatNumber(point[1]) : '—'}</b><small>{valid ? formatLocalTs(new Date(point[0]).toISOString()) : t('histEmpty')}</small></div> })}
      </div>}
    </div>
    <div className="history-legend-head"><span>{t('histLegendHint')}</span><span>{t('histStatsHint')}</span></div>
    <div className="history-legend">
      {visibleSeries.map(s => { const reg = registers.find(r => r.id === s.id); return <button key={s.id} className={'history-series-toggle' + (hidden.has(s.id) ? ' muted' : '')} aria-pressed={!hidden.has(s.id)} onClick={() => setHidden(old => { const next = new Set(old); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next })}>
        <span className="legend-swatch" style={{ background: s.color }} /><strong>{reg?.alias || `#${reg?.startAddress ?? s.id}`} <small>({reg?.startAddress})</small></strong>
        <span>Min <b>{Number.isFinite(s.min) ? formatNumber(s.min) : '—'}</b></span><span>Max <b>{Number.isFinite(s.max) ? formatNumber(s.max) : '—'}</b></span><span>{t('histLastValue')} <b>{s.last === null ? '—' : formatNumber(s.last)}</b></span>
      </button> })}
    </div>
    <p className="chart-hint history-sampling-note">{t('histSamplingNote')}{relative && ' ' + t('histRelativeNote')}</p>
  </div>
}

function RawDataView({ t, device }: { t: T; device: Device | null }) {
  const [frames, setFrames] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)
  const clampLimit = (v: number) => Math.max(1, Math.min(2000, Math.trunc(v) || 200))
  const load = useCallback(async () => {
    if (!device) { setFrames([]); setErr(null); return }
    setBusy(true); setErr(null)
    try { setFrames(await api.get('/api/monitor_objects/' + device.id + '/frames?limit=' + clampLimit(limit))) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }, [device, limit])
  useEffect(() => { void load(); const id = setInterval(() => { void load() }, 1000); return () => clearInterval(id) }, [load])
  const clear = async () => { if (!device) return; try { await api.post('/api/monitor_objects/' + device.id + '/frames/clear', {}); await load() } catch { /* */ } }
  const dir = (d: string) => d === 'tx' ? 'TX' : 'RX'
  if (!device) return <div className="db-view"><div className="hist-empty">{t('emptyHint')}</div></div>
  return (
    <div>
      <div className="toolbar">
        <span className="kv">串口/TCP 原始报文（自动刷新 1s）</span>
        <label className="kv">显示帧数
          <input type="number" min={1} max={2000} value={limit}
            style={{ width: 70, marginLeft: 6 }}
            onChange={(e) => setLimit(clampLimit(Number(e.target.value)))}
            onBlur={(e) => { const v = clampLimit(Number(e.target.value)); setLimit(v); void load() }} />
        </label>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void load()} disabled={busy}>{busy ? '…' : '刷新'}</button>
        <button className="btn" onClick={() => void clear()}>清空</button>
      </div>
      {err && <div className="write-msg error">{err}</div>}
      <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, maxHeight: '60vh', overflow: 'auto', background: 'var(--bg-2, #111)', color: 'var(--text-1, #eee)', borderRadius: 6, padding: 8 }}>
        {frames.length === 0 ? <div className="kv">暂无原始帧（确认设备已连接并轮询）</div> : (
          frames.map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 10, padding: '1px 0', borderBottom: '1px solid var(--border-1, #222)' }}>
              <span style={{ color: 'var(--text-3, #888)', minWidth: 72 }}>{formatLocalTs(f.timestamp).slice(11)}</span>
              <span style={{ color: f.direction === 'tx' ? '#5fd7ff' : '#7ce08a', minWidth: 28, fontWeight: 600 }}>{dir(f.direction)}</span>
              <span style={{ minWidth: 40, color: 'var(--text-2, #bbb)' }}>{f.slaveId != null ? 'slave ' + f.slaveId : ''}</span>
              <span style={{ minWidth: 44, color: 'var(--text-2, #bbb)' }}>FC{f.functionCode ?? '?'}{f.isException ? ' (err ' + f.exceptionCode + ')' : ''}</span>
              <span style={{ color: 'var(--text-3, #999)', minWidth: 40 }}>{f.byteLength}B</span>
              <span style={{ wordBreak: 'break-all' }}>{f.hex ? f.hex.replace(/(..)/g, '$1 ').replace(/\s+$/, '') : ''}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function FirmwareView({ t, device }: { t: T; device: Device }) {
  const [firmwares, setFirmwares] = useState<any[]>([])
  const [status, setStatus] = useState<any>({ state: 'idle' })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => { try { setFirmwares(await api.get('/api/firmwares')) } catch { /* ignore */ } }, [])
  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let alive = true
    const poll = async () => { try { const s = await api.get('/api/ota/status?device_id=' + device.id); if (alive) setStatus(s) } catch { /* ignore */ } }
    void poll()
    const timer = setInterval(poll, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [device.id])

  const onFile = async (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMsg('')
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch('/api/firmware/upload?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      await refresh()
      setMsg(t('fwUploaded'))
    } catch (err: any) { setMsg(t('fwUploadErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false); e.target.value = '' }
  }

  const upgrade = async (fid: number) => {
    setBusy(true); setMsg('')
    try { await api.post('/api/ota/upgrade', { device_id: device.id, firmware_id: fid }); setMsg(t('fwStarted')) }
    catch (err: any) { setMsg(t('fwUpgradeErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false) }
  }

  const remove = async (fid: number, name: string) => {
    if (!window.confirm(t('confirmDeleteFirmware').replace('{name}', name))) return
    setBusy(true); setMsg('')
    try { await api.del('/api/firmwares/' + fid); await refresh() }
    catch (err: any) { setMsg(t('fwDeleteErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false) }
  }

  const pct = status.percent ?? 0
  const state = status.state ?? 'idle'
  return (
    <div className="chart-wrap firmware-card">
      <div className="fw-toolbar">
        <label className="btn">{t('fwUpload')}<input type="file" style={{ display: 'none' }} onChange={onFile} disabled={busy} /></label>
        {(state === 'starting' || state === 'transferring' || state === 'verifying') && <button className="btn danger" onClick={() => { void api.post('/api/ota/abort', { device_id: device.id }) }}>{t('fwAbort')}</button>}
      </div>
      {state !== 'idle' && (
        <div className="fw-progress">
          <div className="fw-state">{t('fwState')}: {state} · {pct}% · {status.currentBlock ?? 0}/{status.totalBlocks ?? 0}</div>
          <div className="fw-bar"><div style={{ width: pct + '%' }} /></div>
          {status.error && <div className="fw-err">{status.error}</div>}
        </div>
      )}
      {msg && <div className="write-msg">{msg}</div>}
      <div className="fw-list">
        {firmwares.length === 0 && <div className="chart-hint">{t('firmwareHint')}</div>}
        {firmwares.map((f) => (
          <div key={f.id} className="fw-item">
            <div className="fw-name">{f.name} <span className="kv">{f.version || '—'}</span></div>
            <div className="kv">{f.size} B · crc32=0x{(f.crc32 >>> 0).toString(16)}</div>
            <button className="btn" disabled={busy} onClick={() => { void upgrade(f.id) }}>{t('fwUpgrade')}</button>
            <button className="btn danger" disabled={busy} onClick={() => { void remove(f.id, f.name) }}>{t('fwDelete')}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsModal({ t, theme, setTheme, lang, setLang, onClose }: {
  t: T; theme: Theme; setTheme: (v: Theme) => void; lang: Lang; setLang: (v: Lang) => void; onClose: () => void
}) {
  const [msg, setMsg] = useState('')
  const [retention, setRetention] = useState<number>(2592000)
  const [customRetention, setCustomRetention] = useState('')
  useEffect(() => { api.get('/api/retention').then((r: any) => setRetention(r.retention_seconds)).catch(() => {}) }, [])
  const clearLogs = async () => { await api.post('/api/logs/clear'); setMsg(t('logsCleared')) }
  const retentionPresets: Array<[string, number]> = [
    ['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800], ['30d', 2592000], ['90d', 7776000], [t('retentionForever'), 0],
  ]
  const applyRetention = async (seconds: number) => {
    setRetention(seconds)
    try { await api.post('/api/retention', { retention_seconds: seconds }); setMsg(t('retentionSaved')) } catch { /* ignore */ }
  }
  const saveCustomRetention = async () => {
    const s = Number(customRetention)
    if (!Number.isInteger(s) || s < 0) return
    await applyRetention(s)
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('settingsTitle')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
      <div className="settings-card">
        <h4>{t('appearance')}</h4>
        <div className="setting-row">
          <span>{t('themeLabel')}</span>
          <div className="seg">
            <button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}>{t('light')}</button>
            <button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}>{t('dark')}</button>
            <button className={theme === 'system' ? 'selected' : ''} onClick={() => setTheme('system')}>{t('system')}</button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h4>{t('language')}</h4>
        <div className="setting-row">
          <span>{t('language')}</span>
          <div className="seg">
            <button className={lang === 'zh' ? 'selected' : ''} onClick={() => setLang('zh')}>中文</button>
            <button className={lang === 'en' ? 'selected' : ''} onClick={() => setLang('en')}>English</button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h4>{t('appInfo')}</h4>
        <div className="setting-row"><span>{t('version')}</span><span className="kv">0.1.0</span></div>
        <div className="setting-row"><span>{t('arch')}</span><span className="kv">Cordis · TypeScript</span></div>
        <div className="setting-row"><span>{t('persistence')}</span><span className="kv">SQLite + DuckDB</span></div>
      </div>
      <div className="settings-card">
        <h4>{t('dataMgmt')}</h4>
        <div className="setting-row">
          <span>{t('retentionLabel')}</span>
          <select value={retentionPresets.some(([, s]) => s === retention) ? String(retention) : 'custom'} onChange={(e) => {
            if (e.target.value === 'custom') { setCustomRetention(String(retention)); return }
            void applyRetention(Number(e.target.value))
          }}>
            {retentionPresets.map(([label, s]) => <option key={s} value={String(s)}>{label}</option>)}
            <option value="custom">自定义 / Custom</option>
          </select>
        </div>
        {!retentionPresets.some(([, s]) => s === retention) && (
          <div className="setting-row">
            <span>秒</span>
            <input value={customRetention} onChange={(e) => setCustomRetention(e.target.value)} placeholder="秒数" />
            <button className="btn" onClick={saveCustomRetention}>{t('add')}</button>
          </div>
        )}
        <div className="setting-row">
          <span>{t('runLogs')}</span>
          <button className="btn" onClick={clearLogs}>{t('clearLogs')}</button>
        </div>
        {msg && <div className="kv" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
      </div>
    </div>
  )
}

function DeviceModal({ t, initial, onClose, onSave }: { t: T; initial: Device | null; onClose: () => void; onSave: (f: DeviceFields) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState(initial?.transport ?? 'tcp')
  const [ip, setIp] = useState(initial?.ip ?? '')
  const [port, setPort] = useState(initial ? String(initial.port) : '8899')
  const [serialPath, setSerialPath] = useState(initial?.serialPath ?? '')
  const [baudRate, setBaudRate] = useState(initial ? String(initial.baudRate ?? 9600) : '9600')
  const [parity, setParity] = useState(initial?.parity ?? 'even')
  const [stopBits, setStopBits] = useState(initial ? String(initial.stopBits ?? 1) : '1')
  const [flowControl, setFlowControl] = useState(initial?.flowControl ?? 'none')
  const [slaveId, setSlaveId] = useState(initial ? String(initial.slaveId ?? 1) : '1')
  const [pollInterval, setPollInterval] = useState(initial ? String(initial.pollIntervalMs ?? 1000) : '1000')
  const [timeout, setTimeout_] = useState(initial ? String(initial.timeoutMs ?? 3000) : '3000')
  const operation = useOperation(t)
  const save = () => operation.run(async () => {
    if (!name.trim() || !(transport === 'rtu' ? serialPath.trim() : ip.trim())) throw new Error(t('requiredFields'))
    await onSave({ name, ip, port: Number(port), transport, serialPath: transport === 'rtu' ? serialPath : '', baudRate: Number(baudRate) || 9600, parity, stopBits: Number(stopBits) || 1, dataBits: 8, flowControl, slaveId: Number(slaveId) || 1, pollIntervalMs: Number(pollInterval) || 1000, timeoutMs: Number(timeout) || 3000 })
  })
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? t('editDeviceTitle') : t('newDeviceTitle')}</h3>
        <Feedback operation={operation} t={t} />
        <label>{t('name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('transport')}</label>
        <select value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="tcp">{t('transportTcp')}</option>
          <option value="rtu">{t('transportRtu')}</option>
        </select>
        <label>{t('slaveIdLabel')}</label>
        <input value={slaveId} onChange={(e) => setSlaveId(e.target.value)} placeholder="1" />
        <label>{t('pollIntervalLabel')}</label>
        <input value={pollInterval} onChange={(e) => setPollInterval(e.target.value)} placeholder="1000" />
        <div className="kv" style={{ marginBottom: 10 }}>{t('pollIntervalHint')}</div>
        <label>{t('timeoutLabel')}</label>
        <input value={timeout} onChange={(e) => setTimeout_(e.target.value)} placeholder="3000" />
        <div className="kv" style={{ marginBottom: 10 }}>{t('timeoutHint')}</div>
        {transport === 'tcp' ? (
          <>
            <label>{t('ip')}</label>
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.90.176" />
            <label>{t('port')}</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8899" />
          </>
        ) : (
          <>
            <label>{t('serialPath')}</label>
            <input value={serialPath} onChange={(e) => setSerialPath(e.target.value)} placeholder="COM3 / /dev/ttyUSB0" />
            <label>{t('baudRate')}</label>
            <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)}>
              {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <label>{t('parity')}</label>
            <select value={parity} onChange={(e) => setParity(e.target.value)}>
              <option value="even">Even</option>
              <option value="odd">Odd</option>
              <option value="none">None</option>
            </select>
            <label>{t('stopBits')}</label>
            <select value={stopBits} onChange={(e) => setStopBits(e.target.value)}>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
            <label>{t('flowControl')}</label>
            <select value={flowControl} onChange={(e) => setFlowControl(e.target.value)}>
              <option value="none">None</option>
              <option value="rtscts">RTS/CTS</option>
              <option value="xonxoff">XON/XOFF</option>
            </select>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" disabled={operation.busy} onClick={() => void save()}>{operation.busy ? t('working') : initial ? t('save') : t('add')}</button>
        </div>
      </div>
    </div>
  )
}
