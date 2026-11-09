import { DraftNavigation, type DraftRange, type DraftRegistration, type RetainedDraft } from './draft-navigation'
import { RetainedDraftNotice } from './RetainedDraftNotice'
import { bindBeforeUnload } from './before-unload'
import { RecordingIntervalNotice } from './RecordingIntervalNotice'
import { PersistenceStatus } from './PersistenceStatus'
import { RetentionSummary } from './RetentionSummary'
import { RealtimeFallbackRead } from './realtime-fallback'
import { registerWritePayloadValue } from '../../../packages/core/src/register-write-value'
import { bindUiTheme, readUiLanguage, readUiTheme, readSidebarCollapsed, saveUiLanguage, saveSidebarCollapsed } from './ui-preferences'
import { captureLiveSnapshot } from './live-snapshot'
import { LiveSnapshotPanel } from './LiveSnapshotPanel'
import { LiveSnapshotComparison } from './LiveSnapshotComparison'
import { liveSnapshotComparisonKey, type FrozenLiveObservation } from './live-snapshot-comparison'
import { AliasCell } from './AliasCell'
import { HistoryComparison } from './HistoryComparison'
import { HistoryTimeRange } from './HistoryTimeRange'
import { HistoryReadNotice } from './HistoryReadNotice'
import { HistoryPaginationNotice } from './HistoryPaginationNotice'
import { HistoryCurveSelection } from './HistoryCurveSelection'
import { planHistoryCurve } from '../../../packages/core/src/history-curve-plan'
import { historyReadContextKey, reduceHistoryRead, historyReadView, type HistoryReadState } from './history-read-context'
import { HistoryQueryMemoryPanel } from './HistoryQueryMemory'
import { HistoryQueryMemory, QueryMemoryError, queryMemoryContext } from './history-query-memory'
import { historyTimeRange, resolveHistoryTimeRange, editHistoryTime, changeHistoryInputZone, historyPresetRange } from './history-time-range'
import { LiveWatchList } from './LiveWatchList'
import { captureLiveWatch, liveWatchResult, type LiveWatchSelection } from './live-watch-list'
import { LivePointFilters } from './LivePointFilters'
import { evaluateLivePoints, livePointFilterResult, type LivePointFilter } from './live-point-filter'
import { pickerSources } from './register-picker'
import { DeferredPointDiagnostics } from './DeferredPointDiagnostics'
import { captureHistoryAnchor, historyComparisonContext, updateHistoryComparison, type HistoryComparisonState } from './history-comparison'
import { HistoryNavigation } from './history-navigation'
import { LatestConfigRead, readDeviceGroups, groupsForSelection, readConfigRequest, configReadFailure, type ConfigReadFailure } from './config-read'
import { ConfigLoadNotice } from './ConfigLoadNotice'
import { PointBookImportResult, type PointBookResult } from './PointBookImportResult'
import { capturePointBookOpening, pointBookOpeningMatches, pointBookReplacementPrompt } from './pointbook-confirmation'
import { InvalidPointBookReportError, pointBookReportKind, uploadPointBook as sendPointBook, type PointBookReport } from './pointbook-result'
import { PointLabel, buildPointLabels, type PointLabelData } from './PointLabel'
import { RegisterSelectButton } from './RegisterPicker'
import { sourceKey, sourceSample, withRegisterSources } from '../../../packages/core/src/sample-source.ts'
import { decodeHistoricalSample, historyVerificationLabel } from '../../../packages/core/src/history-integrity.ts'
import type { DeviceFields } from './DeviceModal'
import { DeferredDeviceModal as DeviceModal, DeferredGroupModal as GroupModal } from './DeferredConfigModal'
import { fullGroupForEditing } from './group-settings-save'
import type { DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { saveGuardedDeviceSettings } from './device-settings-save'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteBlocked, configurationWriteReceipt } from './configuration-write-outcome'
import { captureActivation } from '../../../packages/core/src/activation-settings'
import { ActivationUncertainError, saveActivation } from './activation-settings-save'
import { DeviceSlaveStatus } from './DeviceSlaveStatus'
import { CommunicationSummary } from './CommunicationSummary'
import { RawFramesRead, clampFrameLimit } from './raw-frames-read'
import { RawFramesStatus } from './RawFramesStatus'
import { DiagnosticsCleanupButton } from './DiagnosticsCleanupDialog'
import { ColumnControl, ValueModeControl, useDisplayColumns, useValueMode } from './DataDisplayControls'
import { AlarmPanel, useAlarmRules } from './AlarmPanel'
import { ValueReading } from './ValueReading'
import { physicalValue, displayNumber, curveValue, type ValueMode } from './physical-value'
import { DeferredPointSettingsEditor as PointSettingsEditor } from './DeferredConfigModal'
import { capturePointEditBaseline, type PointEditBaseline } from '../../../packages/core/src/point-settings-edit'
import { saveGuardedPointSettings } from './point-settings-save'
import { HistoryQualitySummary } from './HistoryQualitySummary'
import { HistoryQueryTimeoutError } from './history-query'
import { historyQueryPlan, startHistoryQuery, type HistoryQueryTask } from './history-query-task'
import { HistoryExportModal } from './HistoryExportModal'
import { captureHistoryExport, downloadHistoryExport, historyExportContextMatches, type HistoryExportRequest } from './history-export'
import { VirtualTableBody } from './VirtualTableBody'
import { DeviceIssues, type DataTarget } from './DeviceIssues'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { showOperationNotice } from './OperationNotifications'
import './styles.css'
import { AssistantPanel } from './AssistantPanel'
import { DeferredSettingsModal } from './DeferredSettingsModal'
import { decodeHistorySeries, historySampleStats, historyLineStarts, historyQueryRange, isolatedHistoryPoints, nearestHistorySample, type HistoryPoint, type HistorySeries } from './history-curve'
import { curveDisplayPoints, curveTrackFor, isolatedCurvePoints, sampleCurve, type CurveBuffer } from './live-curve'
import { pointHealth, sampleTime, sampleAgeSeconds, staleAfterMs, type Sample } from './observation'
import { sameResponseBatch } from '../../../packages/core/src/sample-batch.ts'
import { decodeRawByAddr, decodeRegister, formatNumber, formatRegisterValue, isBinType, isHexType, parseEnum, registerWidth } from '../../../packages/core/src/codec.ts'

const TYPE_GROUPS = [
  { key: 'grp16BE', types: ['int16', 'uint16', 'float16', 'hex16', 'bin16'] },
  { key: 'grp16LE', types: ['int16-LE', 'uint16-LE', 'float16-LE', 'hex16-LE', 'bin16-LE'] },
  { key: 'grp32BE', types: ['int32', 'uint32', 'float32', 'hex32', 'bin32'] },
  { key: 'grp32LE', types: ['int32-LE', 'uint32-LE', 'float32-LE', 'hex32-LE', 'bin32-LE'] },
  { key: 'grp64BE', types: ['int64', 'uint64', 'float64', 'hex64', 'bin64'] },
  { key: 'grp64LE', types: ['int64-LE', 'uint64-LE', 'float64-LE', 'hex64-LE', 'bin64-LE'] },
]

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number; transport: string; serialPath: string | null; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number; dataRetainSeconds: number | null; connected: boolean }
interface Register { slaveId?: number; sourceAmbiguous?: boolean; id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null; decimalPlaces?: number | null }
interface DeviceGroup { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number; registers: Register[] }
interface LatestValue extends Sample {}

type Lang = 'zh' | 'en'
type Theme = 'light' | 'dark' | 'system'
type T = (key: string) => string
type RealtimeStatus = 'connecting' | 'connected' | 'stale' | 'reconnecting' | 'disconnected'

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    pointCheckTab: '点表检查', pointCheckWaiting: '正在等待点表配置；加载失败时可使用顶部重试。',
    histCompareTitle: 'A/B 两点对比', histCompareHint: '先在图中移动指针或点击选择时刻，再设置 A、B。逐点取最近的显示采样，不插值；请核对每点实际采样时间。', histCompareSetA: '当前时刻设为 A', histCompareSetB: '当前时刻设为 B', histCompareClear: '清空对比', histCompareCursorDelta: '游标时间差 B − A', histCompareA: 'A 最近显示采样', histCompareB: 'B 最近显示采样', histCompareDifference: '数值差 B − A', histCompareSampleDelta: '实际采样时间差', histCompareNoSample: '无可用显示采样', histCompareEmpty: '设置 A/B 后在这里比较；可先设置任意一端。', histCompareLimit: '基于显示采样快照，放大可获取更细数据；断线/无效处显示未知，不跨缺口取值。未验证端点仅供查看，不作自动 PASS/FAIL。缩放或刷新不会改写已设点；更改点位、图例、配置、数值模式或完整时间范围会清空。相对量程仅影响绘图。',
    histNavigationWaiting: '正在等待点表加载以定位点位 #{id}；加载失败时可使用顶部重试。', histNavigationMissing: '当前已加载点表中未找到点位 #{id}，请刷新配置后再次点击引用，或重新选择点位。', histNavigationChanged: '点位 #{id} 的来源或类型已变化，未自动定位；请核对当前点位后重新点击告警引用。', histNavigationInvalid: '历史跳转参数无效，请手动选择时间与点位。',
    pointBookReport: '点表导入结果', pointBookFile: '文件', pointBookCompleted: '导入已完成', pointBookRejected: '导入未完成', pointBookUncertain: '导入结果待核实', pointBookCounts: '服务端回报：{g} 个分组 · {r} 个点位', pointBookWarnings: '需要核对的提示', pointBookErrors: '错误详情', pointBookUncertainHint: '配置是否已更新仍待核实。不要直接重复导入；先核对目标设备当前的分组、点位和告警规则，确认是否已被替换，再决定后续操作。', pointBookInvalidReport: '服务端返回的导入结果格式无效。',
    pointBookCompletedHint: '请核对目标设备的分组、点位（从站/地址/类型/倍率）和告警规则；导入回报不表示设备通信或采样已验证。',
    pointBookWarningsHint: '请逐条核对下方提示，再核对目标设备的分组、点位和告警规则。不要仅为消除提示重复导入；回报不表示设备通信或采样已验证。',
    pointBookRejectedHint: '先核对错误详情、源文件与目标设备当前配置，再决定是否修改文件并重新选择。',
    pointBookTargetSnapshot: '发起时页面目标（仅作记录，不核验当前配置）',
    pointBookPagingHint: '分页只改变显示，全部回报条目仍保留。可用页码跳转，在列表内滚动查看长文本。', pointBookMessageRange: '显示 {start}–{end} / {total} 条 · 第 {page}/{pages} 页', pointBookPage: '页码', pointBookPrevious: '上一页', pointBookNext: '下一页',
    curveScaleUnavailable: '当前数值超出可安全绘制的量程。图形已隐藏，请核对读数和倍率，或调整显示范围。',
    curveTimeReordered: '显示缓存出现倒序时间，图形与读数已按时间戳排列；原记录未改写。这不等同设备故障，请核对采样时间。',
    pointSource: '配置从站', pointSourceUnknown: '配置来源未知',
    pickerSource: '从站', pickerAllSources: '全部从站', pickerSourceUnknown: '来源未知', pickerSearch: '搜索名称、地址或点位编号（id:编号）', pickerClearFilters: '清除筛选', pickerSelectVisible: '选择筛选结果', pickerClearSelection: '清空全部选择',
    connectionUnverified: '设备连接状态未核实',
    sampleTimeUnverified: '采样时间超前，年龄未核实',
    histExportTooLarge: '超过 {n} 条原始行，导出会被截断，已停止生成文件。请取消并减少点位或缩小时间范围后重试。', histExportPreparing: '正在生成导出，可取消本页等待…', histExportTimeout: '导出等待超过 30 秒，本页已停止等待，后台可能继续生成。请缩小时间范围后重试。',
    histExportFull: '导出完整时间范围', histExportViewport: '导出当前缩放区间', histExportSelected: '{n} 个已选点位 · 原始历史（含批次状态）', histExportHint: '按所示时间范围导出，不受图例显隐、Y 轴范围或降采样影响。只读取已选点位所需的数据区和原始字，每次最多 20 万条；超过时请减少点位或缩小时间范围。上限不是导出表格的行数。文件按时间戳解码归组，非逐批原始记录；同时间重复字等无法核实值留空且标未知。未知不等于零或设备故障。',
    histExportCapacityNote: 'XLSX 最多 {n} 个点位（每点位 3 列）。原始行上限不等于内存上限，点位多、时间长仍可能消耗大量内存。建议先减少点位、缩短范围；CSV 也有内存风险。', histExportCancellationNote: '取消或超时只停止本页等待及下载，后台可能继续生成；立即重复导出可能叠加资源占用。',
    histExportContextChanged: '页面配置已变化或尚未核实，已停止此导出。请关闭弹窗，刷新配置后重新打开。', histExportDefinitionNote: '时间和点位ID已固定。文件按下载发起时的后台配置生成；页面发现配置变化会停止导出，尚未同步到页面的后台变更仍需核对。',
    histCancel: '取消查询', histCancelled: '查询已取消，可点击“查询”重新加载。', histTimeout: '查询超过 30 秒，请缩小时间范围后重试。',
    histCoverage: '当前视窗完整区间：{source} 个采样，显示 {shown} 个读数', histSampled: '峰谷保留降采样，放大自动加载细节', histOriginal: '原始采样',
    alarmDelete: '删除', alarmClose: '关闭',
    alarmHistoryHint: '定位的是当前命中条件的采样，不是告警首次发生时间。按当前点表查询原始值，采样可能尚未落库或已被清理；历史质量标记仍需核对。',
    alarmRulesReading: '正在读取规则', alarmRulesUnverified: '规则待核实', alarmRetainedRules: '以下按上次读取规则计算，供核对；不代表当前完整告警状态。', alarmWriteVerify: '保存/删除结果需核实。请先重新读取规则并核对，避免重复操作；重新读取不会重复保存或删除。',
    alarmLabel: '告警', alarmRules: '告警规则', alarmActive: '{n} 项触发', alarmNormal: '未触发', alarmWaiting: '等待有效数据', alarmNone: '未设置规则', alarmTriggered: '条件触发', alarmUnknown: '{n} 项规则暂无有效数据，设备暂停、通信异常或数据过期时不判断告警。', alarmLoadError: '告警规则加载失败', alarmHelp: '按点位类型解码后的原始值比较，不应用系数、偏移或显示舍入。条件命中时持续提示，恢复后自动消除；同一次持续告警只记录一条日志。', alarmInvalid: '请选择点位，并填写有效的原始值阈值。', alarmAdd: '新增规则', alarmEdit: '编辑规则', alarmPoint: '告警点位', alarmChoose: '选择点位', alarmOperator: '比较条件', alarmThreshold: '原始值阈值', alarmMessage: '告警提示（可选）', alarmMessageHint: '例如：温度过高，请检查散热', alarmCancelEdit: '取消编辑', alarmConfirmDelete: '删除这条告警规则？',
    displayValueMode: '数值显示模式', pointDecimals: '物理值小数位数', pointDecimalsAuto: '自动', displayColumns: '显示列', displayColumnsHint: '原始值与物理值共用一列，至少保留一种数值。设置保存在当前浏览器。', displayColumnsConfigHint: '配置模式保留点位设置列，类型在点位设置中修改。原始值在上、物理值在下。', displayColumnsCompact: '精简显示', displayColumnsAll: '显示全部', livePhysicalHint: '按原始解码值 × 系数 + 偏移绘制，不因小数位数设置舍入曲线；悬停读数显示工程单位。', mixedUnitsHint: '当前曲线包含不同工程单位，数值共用纵轴。建议分开选择点位；历史曲线也可使用相对量程比较趋势。', exportRaw: '导出原始值', physicalHistoryHint: '历史物理值按当前点位系数、偏移计算；不是采样时的配置快照。',

    colRawValue: '原始值', colPhysicalValue: '物理值', physicalFormula: '原始值 × {factor} + {offset}', physicalPrecision: '该 64 位数值的小数换算无法精确表示', physicalInvalid: '数值或换算结果无效', physicalRaw: '十六进制 / 二进制格式不进行物理值换算',
    pointSettings: '点位设置', pointSettingsAction: '设置', pointUnit: '工程单位', pointFactor: '系数', pointOffset: '偏移', pointInvalidScale: '系数和偏移必须填写有限数（系数可为 0）。', pointZeroFactorHint: '系数为 0：有效原始值的物理换算结果等于偏移。原始采样值和告警比较不受影响。', pointScaleHint: '物理值 = 原始值 × 系数 + 偏移。单位留空可清除；默认系数为 1、偏移为 0。实时表格同时显示原始值与物理值；曲线可切换两种模式。小数位数仅影响物理值显示，原始值保持解码结果，不改变采集和换算精度。',
    enumConfig: '枚举配置', enumSet: '设置枚举', enumCount: '{n} 项映射', enumValue: '原始数值', enumLabel: '显示文字', enumHint: '按解码后的整数原始值匹配，不应用倍率或偏移。例如 0 → 关闭，1 → 开启；未匹配时仍显示原始值。', enumEmpty: '尚未设置枚举，添加映射即可开始。清空后保存将移除枚举。', enumLabelPlaceholder: '例如：关闭 / 开启', enumAdd: '添加映射', enumRemove: '删除映射', enumClear: '清空映射', enumInvalidValue: '原始数值必须填写十进制整数，可包含负号。', enumDuplicate: '数值 {value} 重复，请为每个数值保留一项映射。', enumEmptyLabel: '请填写每项映射的显示文字。',

    histIntegrityHint: '历史按点位当前分组的从站筛选。批次/来源未验证的值仅供查看，不作为自动 PASS/FAIL 依据；无法归属从站、混批、缺字、同时间重复字或异常显示未知。未知不等于零或设备故障。图中统计包含兼容显示值，不等于已验证采样数。', histQualityVerified: '批次/来源已验证', histQualityUnverified: '批次/来源未验证', histQualityUnknown: '未知',
    histQualityTitle: '采样质量摘要', histQualityHint: '统计当前查询区间内、降采样前的解码采样。未知包括混批、质量异常、缺字或无法表示的数值；可显示数包含批次/来源未验证的兼容值，没有采样的断线时段不计入分母。可显示率不是批次验证率或设备在线率。', histQualityPoint: '点位', histQualitySource: '采样数', histQualityValid: '可显示', histQualityInvalid: '无效', histQualityRate: '可显示率',
    histMinutes: "最近 {n} 分钟", histHours: "最近 {n} 小时", histNoNumeric: "所选点位没有可绘制的数值数据，请检查类型或选择其他点位。", histZoomIn: "放大", histZoomOut: "缩小", histMoveEarlier: "向前移动时间窗口", histMoveLater: "向后移动时间窗口", histQueryZoom: "查询放大区间", histRelative: "各曲线相对量程", histInteractionHint: "悬停查看读数 · 左右拖动框选时间范围 · 双击恢复全范围", histNoVisible: "当前范围没有可见曲线，可重置缩放或点击下方图例显示曲线。", histNearest: "最近采样点（实际时间）", histLegendHint: "点击图例隐藏 / 显示曲线", histStatsHint: "当前可见时间范围的显示数据统计", histLastValue: "末值", histSamplingNote: "曲线按完整查询区间解码，每桶保留首值、末值、峰谷和无效读数；缩放会自动查询细节。Min / Max 统计当前可见显示点，末次采样无效时末值显示为 —。", histRelativeNote: "相对量程将每条曲线映射为 0–100%，恒定值显示在 50%；悬停和统计仍按所选原始值或物理值显示。",
    liveCurve: '实时曲线', liveWindow: '时间窗口', freezeCurve: '暂停画面', resumeCurve: '继续实时', clearCurve: '清空曲线', curveWaiting: '等待新的有效采样数据…', curveSourceChanged: '点位来源或解码类型已变化，已隐藏不匹配的旧曲线和读数；等待新的有效采样。若画面已暂停，请继续实时。', liveCurveHint: '本次打开设备期间缓存；每 250ms 取最新值，最多 8 条曲线、每条 2400 点，保留最近 10 分钟。暂停仅冻结画面，不停止采集。缓存内同时间观测均保留；悬浮显示当前画面最后接收的同时间值，不代表唯一值。', liveRawHint: '按寄存器类型解码原始值，不应用倍率/偏移；不绘制非有限数和无法精确表示的 64 位整数。', curvePaused: '画面已暂停，后台继续缓存', curveTracking: '实时跟随', curveNoNumeric: '暂无可绘制的数值点位，请先配置寄存器。', curveSelectLimit: '最多选择 {n} 个点位', curveTime: '时间',

    groupOldValues: '存在旧值', groupPartialData: '数据不完整', groupCommunicationError: '通信异常', slaveServiceError: '从站服务异常', groupTimeHint: '按组内最早的采样时间显示，避免部分数据未更新被掩盖',
    resizeSidebar: '调整侧边栏宽度', resizeSidebarHint: '拖动调整宽度，双击恢复默认；也可使用左右方向键',
    sortDevices: '调整顺序', finishSorting: '完成排序', moveUp: '上移', moveDown: '下移', dragDevice: '拖动排序', sortingHint: '拖动手柄或点击箭头调整顺序，自动保存在当前浏览器。排序时显示全部设备。', orderSaveFailed: '顺序已调整，但浏览器无法保存；刷新后可能恢复。',
    observe: "观测", configure: "配置", searchPoints: "搜索点位名称或地址", onlyIssues: "只看异常 / 过期", noMatchingPoints: "没有匹配的点位", lastSample: "最近采样", notSampled: "尚未采集", secondsAgo: "{n} 秒前", fresh: "数据新鲜", oldValue: "旧值", coveredWord: "合并占位", shortData: "数据不足", pausedData: "采集已暂停", sampling: "采集中", connectionPending: "等待通信", pageConnection: "实时更新暂时中断，正在通过定时刷新获取数据。", pageUpdateFailed: "数据更新中断，当前保留最后一次获取的结果，正在重试。", pageUpdateTrying: "正在恢复数据更新，并尝试定时刷新。", ageHint: "数据超过 {n} 秒未更新将标记为旧值（按轮询配置估算）", operationOk: "操作成功", operationFailed: "操作失败", working: "处理中…", dismiss: "关闭提示", requiredFields: "请填写名称和连接地址", pointStatus: "数据状态", updatedAt: "更新时间", currentValue: "当前值", noActiveGroups: "没有启用的分组", readOnly: "只读", pointWriteHint: "写入会改变设备值，请核对设备和地址。", importResult: "已导入 {g} 组 / {r} 个点位", loadFailed: "加载失败", refresh: "重试加载",
    searchDevices: '搜索设备或地址', noSearchResults: '没有匹配的设备', expandNav: '展开导航', collapseNav: '收起导航', overview: '设备概览', transportLabel: '通信协议', pointsLabel: '配置点位', groupsLabel: '采集分组', faultsLabel: '异常分组',
    brand: 'ProbeStation',
    brandSub: '设备观测与测试',
    newDevice: '新建设备',
    devices: '设备',
    noDevices: '暂无设备，点上方新建',
    configUnread: '设备清单尚未核实，请查看上方读取提示。',
    deviceListLoading: '正在读取设备清单…', deviceListRefreshing: '正在刷新设备清单，暂显示上次读取内容。',
    deviceDeleteReadBlocked: '设备清单读取中或未核实，本页未发起新的删除。请先重新读取并核对设备；先前删除结果仍须单独核实。',
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
    tabLive: '实时数据', tabHistory: '历史数据', tabCurve: '曲线', tabFirmware: '固件', tabRaw: '通信诊断', histTable: '表格',
    groupCount: '{n} 组',
    newGroup: '新建分组', importPointBook: '导入点位', exportPointBook: '导出点位', editGroup: '编辑分组', groupName: '组名', slaveId: '从站 ID', functionCode: '功能码', startAddress: '起始地址', quantity: '数量', edit: '编辑', save: '保存', fcReadCoils: '读线圈', fcReadDiscrete: '读离散输入', fcReadHolding: '读保持寄存器', fcReadInput: '读输入寄存器',
    histHint: '最近 1 小时数据', histStart: '开始时间', histEnd: '结束时间', histQuery: '查询', histLoading: '查询中…', histPrev: '上一页', histNext: '下一页', histFirst: '首页', histLast: '末页', histTotal: '共 {n} 条', histPage: '第 {x}/{y} 页', noHistory: '暂无历史数据', colTime: '时间', histTruncated: '结果较多，仅显示最近 {n} 条', histIdle: '选择时间范围后点击「查询」', histEmpty: '该时间段暂无历史数据', histError: '查询失败', histRangeInvalid: '开始时间必须早于结束时间', histLast1h: '最近 1 小时', histLast6h: '最近 6 小时', histLast24h: '最近 24 小时', histToday: '今天', histQuick: '快捷', selectRegisters: '选择寄存器', selectAll: '全选', clearAll: '清空', histNoRegs: '未选择任何寄存器', curveHint: '最近 1 小时曲线', curveReset: '重置缩放', curveZoomHint: '框选放大：左上→右下拖拽；恢复：右下→左上拖拽', firmwareHint: '暂无固件，请先上传', fwUpload: '上传固件', fwAbort: '中止升级', fwState: '状态', fwUpgrade: '升级', fwUploaded: '固件已上传', fwUploadErr: '上传失败', fwStarted: '升级已发起', fwUpgradeErr: '升级发起失败', fwDelete: '删除', fwDeleted: '固件已删除', fwDeleteErr: '删除失败', confirmDeleteFirmware: '确定删除固件 {name} 吗？',
    appearance: '外观', themeLabel: '主题', light: '浅色', dark: '深色', system: '跟随系统',
    language: '语言',
    appInfo: '应用信息', version: '版本', arch: '架构', persistence: '持久化',
    dataMgmt: '数据管理', runLogs: '运行日志', clearLogs: '清空日志', logsCleared: '日志已清空', retentionLabel: '历史保留', retentionSaved: '保留时长已保存', retentionForever: '永久',
    newDeviceTitle: '新建设备', editDeviceTitle: '编辑设备', name: '名称', ip: 'IP 地址', port: '端口', transport: '连接方式', transportTcp: 'TCP 网口', transportRtu: 'RTU 串口', serialPath: '串口路径', baudRate: '波特率', parity: '校验位', stopBits: '停止位', dataBits: '数据位', flowControl: '流控', slaveIdLabel: '从站地址', pollIntervalLabel: '扫描间隔(ms)', pollIntervalHint: '按分组轮流轮询，每个分组约每「间隔 × 分组数」刷新一次', timeoutLabel: '读写超时(ms)', timeoutHint: '读/写寄存器请求的超时，默认 3000 毫秒（超过判失败）', cancel: '取消', add: '添加',
    importPoints: '导入点表', importTitle: '智能导入点表', importHint: '粘贴 CSV（首行表头含 地址/名称/类型/枚举 等列），或上传 CSV/XLSX 文件；也支持 JSON 数组。', importPh: '粘贴点表 CSV（首行表头：地址,名称,类型,枚举）', importFile: '上传文件', importDo: '导入', importEmpty: '请输入内容或选择文件', impBadJson: '无法解析 JSON 数组', importUpdated: '更新 {n} 个', importSkipped: '跳过 {n} 个', importErrors: '错误', importColumns: '识别列',
    tabMonitor: '设备观测', tabDatabase: '数据管理', dbHistory: '历史数据', dbTotalRows: '采样总行数', dbTimeSpan: '时间跨度', dbDiskUsage: '磁盘占用', dbPerDevice: '每台设备', dbMetadata: '元数据', dbRetention: '保留策略', dbRefresh: '刷新', dbNoData: '暂无历史数据', dbBufferHint: '内存缓冲 {n} 条待落盘', dbDevices: '设备', dbGroups: '分组', dbRegisters: '寄存器', dbRules: '告警规则', dbFirmwares: '固件', dbLogs: '日志', dbRetentionForever: '永久', dbRetentionDays: '{n} 天',
  },
  en: {
    pointCheckTab: 'Point table check', pointCheckWaiting: 'Waiting for point definitions. Use the retry control above if loading fails.',
    histCompareTitle: 'A/B sample comparison', histCompareHint: 'Move or tap in the plot, then set A and B. Use nearest displayed samples without interpolation; check each actual sample time.', histCompareSetA: 'Set A at cursor', histCompareSetB: 'Set B at cursor', histCompareClear: 'Clear comparison', histCompareCursorDelta: 'Cursor elapsed B − A', histCompareA: 'A nearest displayed sample', histCompareB: 'B nearest displayed sample', histCompareDifference: 'Value B − A', histCompareSampleDelta: 'Actual sample elapsed', histCompareNoSample: 'No usable displayed sample', histCompareEmpty: 'Set either endpoint to begin comparing.', histCompareLimit: 'Frozen displayed-sample snapshots; zoom for detail. Gaps and invalid data stay unknown. Unverified endpoints are view-only, never automatic PASS/FAIL evidence. Zoom/refresh keeps snapshots; changes to points, legend, configuration, value mode or full range clear them. Relative scaling affects the plot only.',
    histNavigationWaiting: 'Waiting for point definitions to locate #{id}. Use the retry control above if loading fails.', histNavigationMissing: 'Point #{id} was not found in the loaded definitions. Refresh configuration and reopen the reference, or select a point.', histNavigationChanged: 'Point #{id} source or type changed; automatic focus blocked. Check the point and click its alarm reference again.', histNavigationInvalid: 'Invalid history navigation parameters. Select the time range and points manually.',
    pointBookReport: 'Point table import result', pointBookFile: 'File', pointBookCompleted: 'Import completed', pointBookRejected: 'Import not completed', pointBookUncertain: 'Import outcome unconfirmed', pointBookCounts: 'Server report: {g} groups · {r} points', pointBookWarnings: 'Items to review', pointBookErrors: 'Error details', pointBookUncertainHint: 'Whether the configuration changed is unconfirmed. Do not import again immediately; first check the target device\'s current groups, points and alarm rules for replacement, then decide what to do next.', pointBookInvalidReport: 'The server returned an invalid import report.',
    pointBookCompletedHint: 'Check the target device\'s groups, points (slave/address/type/scale) and alarm rules; this report does not verify device communication or sampling.',
    pointBookWarningsHint: 'Review each item below, then check the target device\'s groups, points and alarm rules. Do not re-import just to clear warnings; this report does not verify device communication or sampling.',
    pointBookRejectedHint: 'Check the error details, source file and target device\'s current configuration before deciding whether to edit and select the file again.',
    pointBookTargetSnapshot: 'Page target when sent (record only, not current configuration verification)',
    pointBookPagingHint: 'Paging changes display only; all received entries are retained. Jump by page number and scroll the list to read long text.', pointBookMessageRange: 'Showing {start}–{end} of {total} · Page {page}/{pages}', pointBookPage: 'Page', pointBookPrevious: 'Previous', pointBookNext: 'Next',
    curveScaleUnavailable: 'This numeric range cannot be drawn safely. The plot is hidden; check the readings and scale, or adjust the display range.',
    curveTimeReordered: 'Out-of-order times were observed in this view. Curves and readouts are ordered by timestamp; original records are unchanged. This does not establish a device fault. Check sampling times.',
    pointSource: 'Configured slave', pointSourceUnknown: 'Configured source unknown',
    pickerSource: 'Slave', pickerAllSources: 'All slaves', pickerSourceUnknown: 'Unknown source', pickerSearch: 'Search name, address or point ID (id:number)', pickerClearFilters: 'Clear filters', pickerSelectVisible: 'Select results', pickerClearSelection: 'Clear selection',
    connectionUnverified: 'Device connection unverified',
    sampleTimeUnverified: 'Sample time ahead; age unverified',
    histExportTooLarge: 'More than {n} raw rows: exporting would truncate the data, so no file was generated. Cancel, select fewer points or narrow the time range and retry.', histExportPreparing: 'Preparing an export. You can stop waiting…', histExportTimeout: 'This page stopped waiting after 30 seconds. Backend generation may continue. Narrow the range before retrying.',
    histExportFull: 'Export full time range', histExportViewport: 'Export zoomed time range', histExportSelected: '{n} selected points · Raw history with batch status', histExportHint: 'Export the stated time range regardless of legend visibility, Y-axis limits or downsampling. Read only the raw words required by selected points, up to 200,000 rows. Select fewer points or narrow the range if exceeded. This is not the number of spreadsheet rows. Files group decoded values by timestamp, not individual batches; duplicate words at the same time and other unverifiable values are blank and unknown. Unknown does not mean zero or a device fault.',
    histExportCapacityNote: 'XLSX supports up to {n} points (3 columns per point). The raw-row limit is not a memory limit: wide or long exports can still use substantial memory. Start with fewer points and a shorter range; CSV also has memory risks.', histExportCancellationNote: 'Cancel or timeout stops this page waiting and downloading. Backend generation may continue; immediately starting another export may add resource load.',
    histExportContextChanged: 'Page configuration changed or is unverified. This export was stopped. Close, refresh configuration and reopen the dialog.', histExportDefinitionNote: 'Time and point IDs are fixed. The file uses backend definitions at download start. Observed page changes stop export; backend changes not yet received by this page still need verification.',
    histCancel: 'Cancel query', histCancelled: 'Query cancelled. Click Query to reload.', histTimeout: 'Query exceeded 30 seconds. Narrow the time range and retry.',
    histCoverage: 'Full visible range: {source} samples, {shown} displayed', histSampled: 'Extrema preserved; zoom reloads detail', histOriginal: 'Original samples',
    alarmDelete: 'Delete', alarmClose: 'Close',
    alarmHistoryHint: 'Navigates to the current matching sample, not the first alarm occurrence. Queries raw values with current point definitions; the sample may not be persisted or retained. Check historical quality labels.',
    alarmRulesReading: 'Reading rules', alarmRulesUnverified: 'Rules unverified', alarmRetainedRules: 'Calculated with the last rule list for review; not the complete current alarm status.', alarmWriteVerify: 'Save/delete outcome needs verification. Read the rules again and check before repeating the operation; rereading never saves or deletes.',
    alarmLabel: 'Alarms', alarmRules: 'Alarm rules', alarmActive: '{n} triggered', alarmNormal: 'Not triggered', alarmWaiting: 'Waiting for valid data', alarmNone: 'No rules configured', alarmTriggered: 'Condition triggered', alarmUnknown: '{n} rules lack valid data. Paused devices, communication faults and stale samples are not evaluated.', alarmLoadError: 'Failed to load alarm rules', alarmHelp: 'Compare decoded raw values without scaling, offsets or display rounding. Show alarms while conditions match and clear when they recover. Log once per continuous alarm.', alarmInvalid: 'Select a point and enter a finite raw threshold.', alarmAdd: 'Add rule', alarmEdit: 'Edit rule', alarmPoint: 'Point', alarmChoose: 'Select a point', alarmOperator: 'Comparison', alarmThreshold: 'Raw threshold', alarmMessage: 'Alarm message (optional)', alarmMessageHint: 'Example: Temperature too high', alarmCancelEdit: 'Cancel editing', alarmConfirmDelete: 'Delete this alarm rule?',
    displayValueMode: 'Value display mode', pointDecimals: 'Physical value decimal places', pointDecimalsAuto: 'Automatic', displayColumns: 'Columns', displayColumnsHint: 'Raw and physical values share one column. Keep at least one value type. Saved in this browser.', displayColumnsConfigHint: 'Point settings remain visible while configuring; edit the type in point settings. Raw values above physical values.', displayColumnsCompact: 'Compact view', displayColumnsAll: 'Show all', livePhysicalHint: 'Plot raw value × factor + offset at full precision. Display precision affects text only; readings include engineering units.', mixedUnitsHint: 'These series use different engineering units on a shared axis. Select them separately, or compare trends using relative ranges in history.', exportRaw: 'Export raw values', physicalHistoryHint: 'Historical physical values use the current point factor and offset, not the configuration at sampling time.',

    colRawValue: 'Raw value', colPhysicalValue: 'Physical value', physicalFormula: 'Raw value × {factor} + {offset}', physicalPrecision: 'Decimal scaling of this 64-bit value cannot be represented precisely', physicalInvalid: 'Invalid value or conversion result', physicalRaw: 'Hex / binary formats do not use physical conversion',
    pointSettings: 'Point settings', pointSettingsAction: 'Settings', pointUnit: 'Engineering unit', pointFactor: 'Scale factor', pointOffset: 'Offset', pointInvalidScale: 'Enter a finite factor and offset (zero factor is allowed).', pointZeroFactorHint: 'Factor 0: the physical conversion of a valid raw value equals the offset. Raw samples and alarm comparisons are unchanged.', pointScaleHint: 'Physical value = raw value × scale factor + offset. Leave the unit blank to remove it. Defaults: factor 1, offset 0. Live tables show raw and physical values; curves can switch modes. Decimal places affect physical value display only. Raw values keep their decoded form; acquisition and conversion precision are unchanged.',
    enumConfig: 'Enum mappings', enumSet: 'Set enum', enumCount: '{n} mappings', enumValue: 'Raw value', enumLabel: 'Display text', enumHint: 'Match decoded integer values before scaling or offset. For example, 0 → Off and 1 → On. Unmatched values remain numeric.', enumEmpty: 'No mappings. Add a mapping to start; saving an empty list removes the enum.', enumLabelPlaceholder: 'For example: Off / On', enumAdd: 'Add mapping', enumRemove: 'Remove mapping', enumClear: 'Clear mappings', enumInvalidValue: 'Enter a decimal integer, optionally with a minus sign.', enumDuplicate: 'Duplicate value {value}. Keep one mapping per value.', enumEmptyLabel: 'Enter display text for every mapping.',

    histIntegrityHint: 'History follows the point’s current group slave. Unverified values are view-only, never automatic PASS/FAIL evidence. Mixed, incomplete or bad samples, including duplicate words at the same time, are unknown. Unknown does not mean zero or a device fault. Display statistics include compatibility values, not only verified samples.', histQualityVerified: 'Batch/source verified', histQualityUnverified: 'Batch/source unverified', histQualityUnknown: 'Unknown',
    histQualityTitle: 'Sample quality summary', histQualityHint: 'Counts cover decoded samples in the queried range before downsampling. Unknown includes mixed batches, bad quality, missing words and unrepresentable values. Displayable counts include unverified compatibility values. Outages with no samples are excluded; this is neither verification rate nor uptime.', histQualityPoint: 'Point', histQualitySource: 'Samples', histQualityValid: 'Displayable', histQualityInvalid: 'Invalid', histQualityRate: 'Displayable rate',
    histMinutes: "Last {n} minutes", histHours: "Last {n} hours", histNoNumeric: "No plottable numeric data. Check types or select other points.", histZoomIn: "Zoom in", histZoomOut: "Zoom out", histMoveEarlier: "Move earlier", histMoveLater: "Move later", histQueryZoom: "Query zoomed range", histRelative: "Relative scale per series", histInteractionHint: "Hover for values · Drag horizontally to select time · Double-click to reset", histNoVisible: "No visible series in this range. Reset zoom or enable a legend item.", histNearest: "Nearest samples (actual times)", histLegendHint: "Click a legend item to hide / show", histStatsHint: "Statistics of displayed samples in the visible range", histLastValue: "Last", histSamplingNote: "Decoded samples retain the first, last, extrema and invalid readings per bucket. Zooming automatically queries finer detail. Min / Max describe visible display samples; Last is — if the final sample is invalid.", histRelativeNote: "Each series maps to 0–100%; constant values appear at 50%. Readouts and statistics retain values in the selected display mode.",
    liveCurve: 'Live curves', liveWindow: 'Time window', freezeCurve: 'Freeze view', resumeCurve: 'Resume live', clearCurve: 'Clear curves', curveWaiting: 'Waiting for new valid samples…', curveSourceChanged: 'Point source or decoding type changed. Mismatched old curves and readings are hidden; waiting for valid samples. Resume live if the view is frozen.', liveCurveHint: 'Buffered while this device is open. Latest values sampled every 250ms; up to 8 series, 2400 points each, retained for 10 minutes. Freezing does not stop acquisition. Equal-time observations in this buffer are retained; hover shows the last received equal-time value in this frame, not a unique value.', liveRawHint: 'Raw values decoded by register type, without factor/offset. Non-finite values and unsafe 64-bit integers are omitted.', curvePaused: 'View frozen; buffering continues', curveTracking: 'Following live data', curveNoNumeric: 'No numeric points available. Configure registers first.', curveSelectLimit: 'Select up to {n} points', curveTime: 'Time',

    groupOldValues: 'Stale data present', groupPartialData: 'Incomplete data', groupCommunicationError: 'Communication error', slaveServiceError: 'Slave service error', groupTimeHint: 'Shows the oldest sample in the group so partial updates do not hide stale data',
    resizeSidebar: 'Resize sidebar', resizeSidebarHint: 'Drag to resize, double-click to reset, or use Left and Right arrow keys',
    sortDevices: 'Reorder', finishSorting: 'Done', moveUp: 'Move up', moveDown: 'Move down', dragDevice: 'Drag to reorder', sortingHint: 'Drag the handle or use the arrows. Saved in this browser. All devices are shown while reordering.', orderSaveFailed: 'Order changed, but browser storage is unavailable; it may reset on reload.',
    observe: "Observe", configure: "Configure", searchPoints: "Search point name or address", onlyIssues: "Issues / stale only", noMatchingPoints: "No matching points", lastSample: "Latest sample", notSampled: "Not sampled", secondsAgo: "{n}s ago", fresh: "Fresh", oldValue: "Old value", coveredWord: "Merged word", shortData: "Incomplete data", pausedData: "Sampling paused", sampling: "Sampling", connectionPending: "Awaiting communication", pageConnection: "Live updates interrupted. Fetching data with periodic refreshes.", pageUpdateFailed: "Updates unavailable. Keeping the last received results and retrying.", pageUpdateTrying: "Restoring updates and trying periodic refreshes.", ageHint: "Values older than {n}s are marked stale (estimated from polling settings)", operationOk: "Operation succeeded", operationFailed: "Operation failed", working: "Working…", dismiss: "Dismiss", requiredFields: "Enter a name and connection address", pointStatus: "Data status", updatedAt: "Updated", currentValue: "Current value", noActiveGroups: "No enabled groups", readOnly: "Read only", pointWriteHint: "Writing changes the device value. Check the device and address.", importResult: "Imported {g} groups / {r} points", loadFailed: "Loading failed", refresh: "Retry loading",
    searchDevices: 'Search devices or addresses', noSearchResults: 'No matching devices', expandNav: 'Expand navigation', collapseNav: 'Collapse navigation', overview: 'Device overview', transportLabel: 'Transport', pointsLabel: 'Configured points', groupsLabel: 'Register groups', faultsLabel: 'Group faults',
    brand: 'ProbeStation',
    brandSub: 'Device observation & testing',
    newDevice: 'New Device',
    devices: 'Devices',
    noDevices: 'No devices, create one above',
    configUnread: 'Device list is unverified. See the read notice above.',
    deviceListLoading: 'Reading device list…', deviceListRefreshing: 'Refreshing device list; showing the previous snapshot.',
    deviceDeleteReadBlocked: 'Device list is loading or unverified; no new deletion was sent by this page. Read the list again and verify the device; earlier deletion outcomes still need checking.',
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
    tabLive: 'Live', tabHistory: 'History', tabCurve: 'Curve', tabFirmware: 'Firmware', tabRaw: 'Diagnostics', histTable: 'Table',
    groupCount: '{n} groups',
    newGroup: 'New Group', importPointBook: 'Import points', exportPointBook: 'Export points', editGroup: 'Edit Group', groupName: 'Name', slaveId: 'Slave ID', functionCode: 'Function', startAddress: 'Start addr', quantity: 'Quantity', edit: 'Edit', save: 'Save', fcReadCoils: 'Read Coils', fcReadDiscrete: 'Read Discrete Inputs', fcReadHolding: 'Read Holding', fcReadInput: 'Read Input',
    histHint: 'Last 1 hour', histStart: 'Start', histEnd: 'End', histQuery: 'Query', histLoading: 'Loading…', histPrev: 'Prev', histNext: 'Next', histFirst: 'First', histLast: 'Last', histTotal: '{n} rows', histPage: 'Page {x}/{y}', noHistory: 'No history data', colTime: 'Time', histTruncated: 'Too many rows, showing latest {n}', histIdle: 'Select a time range and click Query', histEmpty: 'No history data in this range', histError: 'Query failed', histRangeInvalid: 'Start time must be before end time', histLast1h: 'Last 1h', histLast6h: 'Last 6h', histLast24h: 'Last 24h', histToday: 'Today', histQuick: 'Quick', selectRegisters: 'Select registers', selectAll: 'Select all', clearAll: 'Clear', histNoRegs: 'No registers selected', curveHint: 'Last 1 hour', curveReset: 'Reset zoom', curveZoomHint: 'Drag top-left→bottom-right to zoom in; drag back to reset', firmwareHint: 'No firmware uploaded yet', fwUpload: 'Upload firmware', fwAbort: 'Abort', fwState: 'State', fwUpgrade: 'Upgrade', fwUploaded: 'Firmware uploaded', fwUploadErr: 'Upload failed', fwStarted: 'Upgrade started', fwUpgradeErr: 'Upgrade failed', fwDelete: 'Delete', fwDeleted: 'Firmware deleted', fwDeleteErr: 'Delete failed', confirmDeleteFirmware: 'Delete firmware {name}?',
    appearance: 'Appearance', themeLabel: 'Theme', light: 'Light', dark: 'Dark', system: 'System',
    language: 'Language',
    appInfo: 'App info', version: 'Version', arch: 'Architecture', persistence: 'Persistence',
    dataMgmt: 'Data management', runLogs: 'Runtime logs', clearLogs: 'Clear logs', logsCleared: 'Logs cleared', retentionLabel: 'Data retention', retentionSaved: 'Retention saved', retentionForever: 'Forever',
    newDeviceTitle: 'New device', editDeviceTitle: 'Edit device', name: 'Name', ip: 'IP address', port: 'Port', transport: 'Transport', transportTcp: 'TCP', transportRtu: 'RTU serial', serialPath: 'Serial path', baudRate: 'Baud rate', parity: 'Parity', stopBits: 'Stop bits', dataBits: 'Data bits', flowControl: 'Flow control', slaveIdLabel: 'Slave ID', pollIntervalLabel: 'Scan interval (ms)', pollIntervalHint: 'Groups poll round-robin; each refreshes roughly every interval × group count', timeoutLabel: 'Timeout (ms)', timeoutHint: 'Read/write request timeout, default 3000 ms', cancel: 'Cancel', add: 'Add',
    importPoints: 'Import points', importTitle: 'Smart point import', importHint: 'Paste CSV (header columns like addr/name/type/enum), or upload CSV/XLSX; JSON array is also accepted.', importPh: 'Paste point-table CSV (header: addr,name,type,enum)', importFile: 'Upload file', importDo: 'Import', importEmpty: 'Enter content or choose a file', impBadJson: 'Cannot parse JSON array', importUpdated: '{n} updated', importSkipped: '{n} skipped', importErrors: 'Errors', importColumns: 'Detected columns',
    tabMonitor: 'Monitor', tabDatabase: 'Data management', dbHistory: 'History data', dbTotalRows: 'Total samples', dbTimeSpan: 'Time span', dbDiskUsage: 'Disk usage', dbPerDevice: 'Per device', dbMetadata: 'Metadata', dbRetention: 'Retention', dbRefresh: 'Refresh', dbNoData: 'No history data yet', dbBufferHint: '{n} buffered rows pending flush', dbDevices: 'Devices', dbGroups: 'Groups', dbRegisters: 'Registers', dbRules: 'Alarm rules', dbFirmwares: 'Firmware', dbLogs: 'Logs', dbRetentionForever: 'Forever', dbRetentionDays: '{n} days',
  },
}

async function request(url: string, options?: RequestInit): Promise<any> {
  const r = await fetch(url, options)
  if (!r.ok) {
    let detail = '', notStarted = false, claimed = false
    try { detail = await r.text() } catch { /* ignore */ }
    try { const parsed = JSON.parse(detail); claimed = parsed?.code === CONFIG_WRITE_NOT_STARTED; notStarted = configurationWriteReceipt(parsed, r.status); detail = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : detail } catch { /* plain text response */ }
    if (claimed && !notStarted) throw new Error('Unverified response')
    const error = new Error('HTTP ' + r.status + (detail ? ' ' + detail.slice(0, 200) : ''))
    if (notStarted) Object.assign(error, { statusCode: 503, version: 1, code: CONFIG_WRITE_NOT_STARTED, outcome: 'not-applied' })
    throw error
  }
  if (r.status === 204) return null
  const data = await r.json()
  if (data?.code === CONFIG_WRITE_NOT_STARTED) throw new Error('Unverified response')
  return data
}

const api = {
  get: (url: string) => request(url),
  post: (url: string, body?: unknown) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  put: (url: string, body: unknown) => request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: (url: string) => request(url, { method: 'DELETE' }),
}
const settingsApi = { get: (url: string, signal: AbortSignal) => request(url, { signal, cache: 'no-store' }), post: api.post }
const fetchPointDiagnostics = (url: string, signal: AbortSignal) => request(url, { signal })
const fetchRawFrames = (url: string, signal: AbortSignal) => request(url, { signal, cache: 'no-store' })

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

/** 浏览器本地时区相对 UTC 的偏移分钟数（东八区为 +480），导出时传给后端做本地化。 */
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

interface RegView { physical?: ReturnType<typeof physicalValue>; value: string; label: string | null; covered: boolean; invalid: boolean; writable: boolean }

/** 枚举命中时返回 label（仅枚举，不参与系数/偏移/单位）。 */
function enumLabelOf(reg: Register, decoded: number | bigint): string | null {
  const map = parseEnum(reg.enumJson)
  if (!map || (typeof decoded !== 'bigint' && !Number.isInteger(decoded))) return null
  const label = map[String(decoded)]
  return label != null ? label : null
}

function areaForFunctionCode(fc: number): string {
  if (fc === 1 || fc === 5 || fc === 15) return 'coil'
  if (fc === 2) return 'discrete-input'
  if (fc === 4) return 'input-register'
  return 'holding-register'
}

/** 按地址顺序合并多字：首字显示合并值、被覆盖字显示 —、数据不足显示 —（不可写）。 */
function buildRegViews(groups: DeviceGroup[], latest: Record<string, LatestValue>, objectId: number, deviceSlaveId?: number): Map<number, RegView> {
  const views = new Map<number, RegView>()
  for (const g of groups) {
    const rawByAddr: Record<number, number> = {}
    const area = areaForFunctionCode(g.functionCode)
    const slaveId = deviceSlaveId ?? g.slaveId
    for (const r of g.registers) for (let i = 0; i < registerWidth(r.dataType); i++) {
      const p = sourceSample(latest, objectId, area, r.startAddress + i, slaveId)
      if (p) rawByAddr[r.startAddress + i] = p.rawValue
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
      const enough = words.length === w && end <= groupEnd && sameResponseBatch(Array.from({ length: w }, (_, i) => sourceSample(latest, objectId, area, start + i, slaveId)))
      if (!enough) {
        views.set(r.id, { value: '—', label: null, covered: false, invalid: true, writable: false })
        continue
      }
      const isRaw = isHexType(r.dataType) || isBinType(r.dataType)
      const decoded = decodeRegister(r.dataType, words)
      const value = isRaw ? formatRegisterValue(r.dataType, words) : displayNumber(decoded)
      const label = isRaw ? null : enumLabelOf(r, decoded)
      const physical = physicalValue(decoded, r)
      views.set(r.id, { value, label, physical, covered: false, invalid: false, writable: true })
      consumedUpTo = end
    }
  }
  return views
}

function useOperation(t: T) {
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const setNotice = (notice: { error: boolean; text: string }) => showOperationNotice(notice, t('dismiss'))
  const run = async (action: () => Promise<unknown>, successText?: (result: unknown) => string, errorText?: (error: unknown) => string) => {
    if (locked.current) return false
    locked.current = true; setBusy(true)
    try { const result = await action(); setNotice({ error: false, text: successText ? successText(result) : t('operationOk') }); return true }
    catch (error) { setNotice({ error: true, text: errorText ? errorText(error) : error instanceof ActivationUncertainError ? error.message : t('operationFailed') + ': ' + (error instanceof Error ? error.message : String(error)) }); return false }
    finally { locked.current = false; setBusy(false) }
  }
  return { busy, setNotice, run }
}

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = () => { if (document.visibilityState !== 'hidden') setNow(Date.now()) }
    const timer = setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [])
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
  const [theme, setTheme] = useState<Theme>(() => readUiTheme())
  const [lang, setLang] = useState<Lang>(() => readUiLanguage())
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
  const [settingsSection, setSettingsSection] = useState<'general' | 'ai'>('general')
  const [aiConfigRevision, setAiConfigRevision] = useState(0)
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed(window.innerWidth))
  const [groupSnapshot, setGroupSnapshot] = useState<{ objectId: number; groups: DeviceGroup[] } | null>(null)
  const groups = useMemo(() => groupsForSelection(groupSnapshot, selectedId), [groupSnapshot, selectedId])
  const [fallbackStatus, setFallbackStatus] = useState<Record<number, boolean>>({})
  const [latest, setLatest] = useState<Record<string, LatestValue>>({})
  const [groupErrors, setGroupErrors] = useState<Record<number, string>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [realtime, setRealtime] = useState<{ status: RealtimeStatus; attempt: number }>({ status: 'connecting', attempt: 0 })
  const [deviceConnected, setDeviceConnected] = useState<Record<number, boolean>>({})
  const [view, setView] = useState<'monitor' | 'database'>('monitor')
  const [dataTarget, setDataTarget] = useState<DataTarget | null>(null)
  const navigationSequence = useRef(0)
  const draftNavigation = useMemo(() => new DraftNavigation(), [])
  const [retainedDrafts, setRetainedDrafts] = useState<readonly RetainedDraft[]>([])
  useEffect(() => bindBeforeUnload(window, retainedDrafts.length > 0, () => draftNavigation.retained().length > 0), [retainedDrafts.length])
  const discardRetainedDraft = (id: number) => {
    try { if (window.confirm(lang === 'en' ? 'Permanently discard this read-only record from page memory? Cancel keeps it. This does not change device configuration.' : '从当前页内存永久丢弃此只读记录？取消可保留，不会修改设备配置。') !== true) return } catch { return }
    draftNavigation.discardRetained(id); setRetainedDrafts(draftNavigation.retained())
  }
  const navigateData = (target: DataTarget) => { if (!canNavigate('monitor', target.deviceId, target.view)) return; setSelectedId(target.deviceId); setView('monitor'); setDataTarget({ ...target, token: ++navigationSequence.current }) }

  const t: T = useCallback((key: string) => I18N[lang][key] ?? key, [lang])
  const operation = useOperation(t)
  const confirmDraftLeave = (ownerId: number | null, range: DraftRange) => draftNavigation.allow(ownerId, range,
    () => window.confirm(lang === 'en' ? 'Leaving discards local editor changes. Continue? Cancel keeps editing. Nothing is saved or retried automatically.' : '离开将丢弃编辑器中的本地修改。确定继续？选择取消可继续编辑，不会自动保存或重试。'),
    () => operation.setNotice({ error: true, text: lang === 'en' ? 'The affected editor is saving or its state is unverified. Wait before leaving; no save is interrupted or retried.' : '将离开的编辑器正在保存或状态待核实，请等待完成；不会中断或重试保存。' }))
  const canNavigate = (nextView: 'monitor' | 'database', nextDeviceId = selectedId, targetView?: DataTarget['view']) => {
    if (view !== 'monitor' || !devices.some(device => device.id === selectedId)) return true
    const range = nextView !== 'monitor' || nextDeviceId !== selectedId ? 'all' : targetView === 'history' || targetView === 'diagnostics' && devices.find(device => device.id === nextDeviceId)?.mode !== 'slave' ? 'live' : null
    return range === null || confirmDraftLeave(selectedId, range)
  }

  const [deviceLoadError, setDeviceLoadError] = useState<ConfigReadFailure | null>(null)
  const [deviceLoading, setDeviceLoading] = useState(true)
  const [groupLoadError, setGroupLoadError] = useState<ConfigReadFailure | null>(null)
  const deviceRead = useRef<LatestConfigRead>()
  const groupRead = useRef<LatestConfigRead>()
  if (!deviceRead.current) deviceRead.current = new LatestConfigRead()
  if (!groupRead.current) groupRead.current = new LatestConfigRead()
  useEffect(() => () => { deviceRead.current?.cancel(); groupRead.current?.cancel() }, [])
  const selectedIdRef = useRef<number | null>(selectedId)
  const fallbackReadRef = useRef<RealtimeFallbackRead<Record<string, LatestValue>>>()
  useEffect(() => { selectedIdRef.current = selectedId; fallbackReadRef.current?.select(selectedId); setFallbackStatus({}) }, [selectedId])

  useEffect(() => bindUiTheme(theme, window.matchMedia('(prefers-color-scheme: dark)'), resolved => document.documentElement.setAttribute('data-theme', resolved)), [theme])
  useEffect(() => { saveUiLanguage(lang) }, [lang])
  useEffect(() => { saveSidebarCollapsed(collapsed) }, [collapsed])

  const refreshDevices = useCallback(() => {
    setDeviceLoading(true)
    void deviceRead.current!.run(async signal => {
      const objs: Device[] = await readConfigRequest('/api/monitor_objects', signal, (url, requestSignal) => request(url, { signal: requestSignal }))
      if (!Array.isArray(objs)) throw new Error('Invalid devices response')
      const map: Record<number, boolean> = {}
      for (const object of objs) {
        if (!object || !Number.isSafeInteger(object.id) || object.id < 1) throw new Error('Invalid device identity')
        map[object.id] = object.connected === true
      }
      return { objs, map }
    }, ({ objs, map }) => { draftNavigation.retainMissing(objs.map(object => object.id)); setRetainedDrafts(draftNavigation.retained()); setDevices(objs); setDeviceConnected(map); setDeviceLoadError(null); setDeviceLoading(false) }, error => { setDeviceLoadError(configReadFailure(error)); setDeviceLoading(false) })
  }, [])
  const refreshRegisters = useCallback((id: number) => {
    void groupRead.current!.run(signal => readDeviceGroups<Register>(id, signal, (url, requestSignal) => readConfigRequest(url, requestSignal, (path, innerSignal) => request(path, { signal: innerSignal }))),
      out => { setGroupSnapshot({ objectId: id, groups: out }); setGroupLoadError(null) },
      error => setGroupLoadError(configReadFailure(error)), () => selectedIdRef.current === id)
  }, [])

  useEffect(() => { refreshDevices() }, [refreshDevices])
  useEffect(() => {
    setGroupSnapshot(null); setGroupLoadError(null)
    if (selectedId != null) refreshRegisters(selectedId)
    return () => groupRead.current?.cancel()
  }, [selectedId, refreshRegisters])
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
    let fallbackRead: RealtimeFallbackRead<Record<string, LatestValue>> | undefined

    const updateStatus = (status: RealtimeStatus, nextAttempt = attempt) => {
      currentStatus = status
      fallbackRead?.setConnected(status === 'connected')
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
    fallbackRead = new RealtimeFallbackRead({
      read: (id, signal) => request('/api/monitor_objects/' + id + '/latest', { signal }),
      accept: (id, snapshot) => { mergeObjectSnapshot(id, snapshot); setFallbackStatus(prev => ({ ...prev, [id]: true })) },
      failed: id => setFallbackStatus(prev => ({ ...prev, [id]: false })),
    })
    fallbackRead.select(selectedIdRef.current)
    fallbackReadRef.current = fallbackRead
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
      if (currentStatus !== 'connected') { setFallbackStatus({}); updateStatus('connected', 0) }
      let msg: any
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (!msg || typeof msg.type !== 'string' || msg.type === 'pong') return
      if (msg.type === 'latest' && msg.data && typeof msg.data === 'object') setLatest(msg.data)
      else if (msg.type === 'poller/result' && Array.isArray(msg.points)) {
        setLatest((prev) => { const next = { ...prev }; for (const p of msg.points) if (p.area) { next[sourceKey(p.objectId, p.area, p.address, p.slaveId ?? null)] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp, timestampMs: p.timestampMs, batchId: p.batchId, slaveId: p.slaveId ?? null }; delete next[p.objectId + ':' + p.area + ':' + p.address] }; return next })
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
        setGroupErrors(() => { const next: Record<number, string> = {}; for (const e of msg.errors) if (e && typeof e.groupId === 'number') next[e.groupId] = e.error; return next })
      }
    }
    const connect = () => {
      if (stopped) return
      setDeviceConnected({})
      const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://'
      updateStatus(attempt === 0 ? 'connecting' : 'reconnecting', attempt)
      const socket = new WebSocket(protocol + location.host + '/ws')
      ws = socket
      socket.onopen = () => {
        if (ws !== socket) return
        attempt = 0
        lastMessageAt = Date.now()
        setFallbackStatus({})
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
    const fallback = setInterval(() => { void fallbackRead!.refresh() }, FALLBACK_MS)
    const onOnline = () => reconnectNow()
    const onVisible = () => { if (document.visibilityState === 'visible' && currentStatus !== 'connected') reconnectNow() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    connect()

    return () => {
      stopped = true
      fallbackRead?.dispose()
      if (fallbackReadRef.current === fallbackRead) fallbackReadRef.current = undefined
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(heartbeat); clearInterval(watchdog); clearInterval(fallback)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      if (ws) { const old = ws; ws = null; old.close() }
    }
  }, [refreshDevices, refreshRegisters])

  const addDevice = useCallback(async (f: DeviceFields) => {
    if (!f.name || (f.transport !== 'rtu' && !f.ip)) return
    try { await api.post('/api/monitor_objects', f) }
    catch (error) {
      const blocked = configurationWriteBlocked(error, true)
      if (blocked) throw blocked
      if (error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) throw error
      throw new Error('新增设备结果待核实，请核对设备列表，勿重复新增。')
    }
    setShowAdd(false); refreshDevices(); operation.setNotice({ error: false, text: t('operationOk') })
  }, [refreshDevices])
  const toggleDevice = async (id: number) => {
    await operation.run(async () => {
      const expected = captureActivation(devices.find(value => value.id === id))
      return saveActivation(expected, expected.isActive ? 0 : 1, api.put, refreshDevices)
    }, warnings => [t('operationOk'), ...warnings as readonly string[]].join(' · '))
  }
  const editDevice = useCallback(async (id: number, f: DeviceFields, expected: DeviceEditBaseline) => {
    if (!f.name) return
    if (id !== expected.id) throw new Error(t('operationFailed'))
    const warnings = await saveGuardedDeviceSettings(expected, f, api.put)
    refreshDevices(); operation.setNotice({ error: false, text: [t('operationOk'), ...warnings].join(' · ') })
  }, [refreshDevices])
  const deleteDevice = async (id: number) => {
    if (deviceLoading || deviceLoadError !== null) { operation.setNotice({ error: true, text: t('deviceDeleteReadBlocked') }); return }
    const device = devices.find((d) => d.id === id)
    const waiting = lang === 'en' ? 'Removal is pending or an editor/save/capture is unverified. No new deletion started; check records and results.' : '移除进行中，或编辑器/保存/留存待核实；本次未发新删除，请先核对记录与结果。'
    if (draftNavigation.removalPending(id)) { operation.setNotice({ error: true, text: waiting }); return }
    if (!draftNavigation.allow(id, 'all', () => true, () => operation.setNotice({ error: true, text: waiting }))) return
    try { if (window.confirm(t('confirmDeleteDevice').replace('{name}', device?.name ?? String(id)) + (lang === 'en' ? '\nDrafts stay read-only in this page; old editors stay disabled on failure. Cancel keeps editing.' : '\n草稿先只读留存在本页；失败时旧编辑器也停用。取消继续编辑。')) !== true) return } catch { return }
    let phase = 0
    await operation.run(async () => {
      const prepared = draftNavigation.beginRemoval(id)
      setRetainedDrafts(draftNavigation.retained())
      if (!prepared) throw new Error(waiting)
      try {
        phase = 1; await api.del('/api/monitor_objects/' + id); phase = 2
        setSelectedId(current => current === id ? null : current)
        refreshDevices()
      } finally { draftNavigation.endRemoval(id); setRetainedDrafts(draftNavigation.retained()) }
    }, undefined, error => {
      const reported = phase === 1 ? configurationWriteBlocked(error, false, lang === 'en') : null
      return reported?.message ?? (phase === 0 || phase === 1 && error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message) ? (error instanceof Error ? error.message : String(error)) : phase === 2 ? (lang === 'en' ? 'Deletion returned success; page refresh failed. Check the device list; do not repeat automatically.' : '删除请求返回成功，但页面未同步；请核对设备清单，勿自动重删。') : (lang === 'en' ? 'Deletion outcome unverified; it may have applied. Check capture results and configuration; do not repeat automatically.' : '删除结果待核实，可能已生效；请核对本页留存及设备配置，勿自动重删。'))
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
                <button className="device-select" aria-current={selectedId === d.id ? 'page' : undefined} onClick={() => { if (!canNavigate('monitor', d.id)) return; setDataTarget(null); setSelectedId(d.id); setView('monitor'); if (window.innerWidth <= 768) setCollapsed(true) }}>
                  <span className={'device-dot' + (realtime.status === 'connected' && deviceConnected[d.id] === true ? ' on' : '')} title={realtime.status !== 'connected' || deviceConnected[d.id] === undefined ? t('connectionUnverified') : undefined} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="device-name">{d.name}</div>
                    <div className="device-sub">{d.transport === 'rtu' ? (d.serialPath || 'RTU') : (d.ip + ':' + d.port)}</div>
                  </div>
                </button>
                  {sortingDevices ? <div className="device-order-actions">
                    <button aria-label={t('moveUp') + ': ' + d.name} title={t('moveUp')} disabled={index === 0} onClick={() => moveDevice(d.id, visibleDevices[index - 1].id)}>↑</button>
                    <button aria-label={t('moveDown') + ': ' + d.name} title={t('moveDown')} disabled={index === visibleDevices.length - 1} onClick={() => moveDevice(d.id, visibleDevices[index + 1].id)}>↓</button>
                  </div> : <button className="device-del" aria-label={t('deleteDevice') + ': ' + d.name} disabled={operation.busy || deviceLoading || deviceLoadError !== null} title={deviceLoading || deviceLoadError !== null ? t('deviceDeleteReadBlocked') : undefined} onClick={() => deleteDevice(d.id)}>×</button>}
                </div>
              ))}
              {devices.length === 0 && <div className="device-sub" role="status" style={{ padding: 8 }}>{t(deviceLoading ? 'deviceListLoading' : deviceLoadError ? 'configUnread' : 'noDevices')}</div>}
              {devices.length > 0 && deviceLoading && <div className="device-sub" role="status" style={{ padding: 8 }}>{t('deviceListRefreshing')}</div>}
              {devices.length > 0 && visibleDevices.length === 0 && <div className="device-sub" style={{ padding: 12 }}>{t('noSearchResults')}</div>}
            </div>
          </>
        )}
        <div className="sidebar-footer">
          <button className="settings-btn" onClick={() => { setSettingsSection('general'); setShowSettings(true) }}>
            <span className="ico">⚙</span>
            {!collapsed && <span>{t('settings')}</span>}
          </button>
        </div>
        {!collapsed && <SidebarResizer t={t} />}
      </aside>

      <main className="main">
        <div className="mobile-header"><button className="btn" aria-label={t('expandNav')} onClick={() => setCollapsed(false)}>☰ {t('devices')}</button><strong>ProbeStation</strong><button className="btn" aria-label={t('settings')} onClick={() => { setSettingsSection('general'); setShowSettings(true) }}>⚙</button></div>

        <ConfigLoadNotice deviceError={deviceLoadError} groupError={groupLoadError} english={lang === 'en'} onRetry={() => { refreshDevices(); if (selectedId != null) refreshRegisters(selectedId) }} />
        <RetainedDraftNotice records={retainedDrafts} english={lang === 'en'} onDiscard={discardRetainedDraft} />
        <DeviceIssues onNavigate={navigateData} english={lang === 'en'} />
        <GlobalTabBar t={t} view={view} onChange={next => { if (!canNavigate(next)) return; if (next === 'database') setDataTarget(null); setView(next) }} />
        {view === 'database'
          ? <DatabaseView t={t} devices={devices} />
          : (selected
              ? <DeviceView drafts={draftNavigation} onLeaveDrafts={range => confirmDraftLeave(selected.id, range)} onNavigate={navigateData} configurationReady={groupSnapshot?.objectId === selectedId} deviceListReady={!deviceLoading && deviceLoadError === null} target={dataTarget?.deviceId === selected.id ? dataTarget : null} key={selected.id} t={t} device={selected} connected={realtime.status === 'connected' ? deviceConnected[selected.id] : undefined} groups={groups} latest={latest} groupErrors={groupErrors} realtime={realtime} fallbackOk={fallbackStatus[selected.id]} busy={operation.busy} onToggle={toggleDevice} onEdit={editDevice} onDelete={deleteDevice} onRefresh={refreshRegisters} />
              : <EmptyState t={t} onAdd={() => setShowAdd(true)} unverified={deviceLoadError !== null} loading={deviceLoading} />)}
      </main>

      <AssistantPanel onNavigate={navigateData} configRevision={aiConfigRevision} onOpenSettings={() => { setSettingsSection('ai'); setShowSettings(true) }} key={selected?.id ?? 'all'} device={selected} onChanged={() => { refreshDevices(); if (selected) refreshRegisters(selected.id) }} />
      {showAdd && <DeviceModal t={t} initial={null} onClose={() => setShowAdd(false)} onSave={addDevice} />}
      {showSettings && <DeferredSettingsModal api={settingsApi} initialSection={settingsSection} onAISaved={() => setAiConfigRevision(v => v + 1)} t={t} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function EmptyState({ t, onAdd, unverified = false, loading = false }: { t: T; onAdd: () => void; unverified?: boolean; loading?: boolean }) {
  return <div className="empty-state"><div className="big">🛰️</div><div role={loading ? 'status' : undefined}>{t(loading ? 'deviceListLoading' : unverified ? 'configUnread' : 'emptyHint')}</div>{!unverified && !loading && <button className="btn primary" onClick={onAdd}>＋ {t('newDevice')}</button>}</div>
}

function GlobalTabBar({ t, view, onChange }: { t: T; view: 'monitor' | 'database'; onChange: (v: 'monitor' | 'database') => void }) {
  return (
    <div className="global-tab-bar">
      <button className={'global-tab' + (view === 'monitor' ? ' active' : '')} onClick={() => onChange('monitor')}>{t('tabMonitor')}</button>
      <button className={'global-tab' + (view === 'database' ? ' active' : '')} onClick={() => onChange('database')}>{t('tabDatabase')}</button>
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

function DatabaseView({ t, devices }: { t: T; devices: Device[] }) {
  const [scope, setScope] = useState('all')
  const device = devices.find(d => String(d.id) === scope) ?? null
  const requestId = useRef(0)
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true); setErr(null); setStats(null)
    try {
      const result = await api.get(device ? '/api/monitor_objects/' + device.id + '/stats' : '/api/stats')
      if (id === requestId.current) setStats(device ? result : { ...result.history, retention: result.retention })
    } catch (e: any) { if (id === requestId.current) setErr(e?.message ?? String(e)) }
    finally { if (id === requestId.current) setLoading(false) }
  }, [device])
  useEffect(() => { void load() }, [load])


  return (
    <div className="db-view">
      <div className="db-head">
        <div>
          <div className="db-title">{t('tabDatabase')}</div>
          <div className="kv" style={{ wordBreak: 'break-all' }}>{device ? device.name + ' · ' + (device.transport === 'rtu' ? device.serialPath : device.ip + ':' + device.port) : '全部设备 / All devices'}</div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void load()} disabled={loading}>{loading ? '…' : t('dbRefresh')}</button>
      </div>
      <div className="toolbar"><label>统计范围 / Scope <select aria-label="统计范围 / Scope" className="hist-input" value={device ? scope : 'all'} onChange={e => setScope(e.target.value)}><option value="all">全部设备 / All devices</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label></div>
      {err && <div className="write-msg error">{err}</div>}

      <PersistenceStatus objectId={device?.id ?? null} english={t('cancel') === 'Cancel'} />

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
        <RetentionSummary retention={stats?.retention} objectId={device?.id ?? null} english={t('cancel') === 'Cancel'} />
      </div>
    </div>
  )
}

function DeviceView({ drafts, onLeaveDrafts, onNavigate, configurationReady, deviceListReady, target, t, device, connected, groups, latest, groupErrors, realtime, fallbackOk, busy, onToggle, onEdit, onDelete, onRefresh }: {
  configurationReady: boolean; deviceListReady: boolean; target: DataTarget | null; t: T; device: Device; connected: boolean | undefined; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>
  drafts?: DraftNavigation; onLeaveDrafts?: (range: DraftRange) => boolean
  onNavigate: (target: DataTarget) => void
  realtime: { status: RealtimeStatus; attempt: number }
  fallbackOk?: boolean
  busy: boolean; onToggle: (id: number) => void; onEdit: (id: number, fields: DeviceFields, expected: DeviceEditBaseline) => Promise<void>; onDelete: (id: number) => void; onRefresh: (id: number) => void
}) {
  const draftScope = useMemo(() => drafts?.scope(device.id), [drafts, device.id])
  const [tab, setTab] = useState(0)
  const queryMemory = useRef<HistoryQueryMemory>()
  if (!queryMemory.current) queryMemory.current = new HistoryQueryMemory(device.id)
  const historyNavigation = useRef<HistoryNavigation>()
  if (!historyNavigation.current) historyNavigation.current = new HistoryNavigation()
  useEffect(() => { if (target) setTab(target.view === 'history' ? 2 : target.view === 'diagnostics' && device.mode !== 'slave' ? 3 : 0) }, [target?.token])
  const [showEdit, setShowEdit] = useState(false)
  const registers = useMemo(() => withRegisterSources(groups.flatMap(g => g.registers), groups, device), [groups, device.mode, device.slaveId])
  useEffect(() => { if (device.mode === 'slave') setTab(current => current === 3 || current === 4 ? 0 : current) }, [device.mode])
  const pointCheckContext = useMemo(() => JSON.stringify([device.id, device.mode, device.slaveId, groups]), [device.id, device.mode, device.slaveId, groups])
  const pointCheckLabels = useMemo(() => buildPointLabels(registers, groups, t, device.mode === 'slave' ? device.slaveId : undefined), [registers, groups, t, device.mode, device.slaveId])
  const now = useNow()
  const threshold = staleAfterMs(device.pollIntervalMs ?? 1000, device.timeoutMs ?? 3000, groups)
  const times = groups.flatMap(g => g.registers.map(r => sampleTime(sourceSample(latest, device.id, areaForFunctionCode(g.functionCode), r.startAddress, device.mode === 'slave' ? device.slaveId : g.slaveId)))).filter((v): v is number => v !== null)
  const lastSample = times.length ? Math.max(...times) : null
  const age = sampleAgeSeconds(lastSample, now)
  return (
    <div className="device-view">
      <div className="section-eyebrow">{t('overview')}</div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive && connected ? ' on' : '')}>{device.mode === 'slave' ? !device.isActive ? '从站已停止' : connected === undefined ? t('connectionUnverified') : connected ? '从站运行中' : '从站未启动' : !device.isActive ? t('pausedData') : !groups.some(g => g.isActive) ? t('noActiveGroups') : connected === undefined ? t('connectionUnverified') : connected ? t('sampling') : t('connectionPending')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={() => onToggle(device.id)}>{device.mode === 'slave' ? device.isActive ? '停止从站' : '启动从站' : device.isActive ? t('disconnect') : t('connect')}</button>
        <button className="btn" onClick={() => setShowEdit(true)}>{t('edit')}</button>
        <button className="btn danger" disabled={busy} onClick={() => onDelete(device.id)}>{t('deleteDevice')}</button>
      </div>
      <div className="main-sub">{device.mode === 'slave' ? '从站 / Slave' : '主站 / Master'} · Modbus {device.transport.toUpperCase()} · {device.transport === 'rtu' ? (device.serialPath || 'RTU') : (device.ip + ':' + device.port)} · {t('groupCount').replace('{n}', String(groups.length))} · {t('regCount').replace('{n}', String(registers.length))}</div>
      {realtime.status !== 'connected' && <div className="connection-notice" role="status">{t(fallbackOk === true ? 'pageConnection' : fallbackOk === false ? 'pageUpdateFailed' : 'pageUpdateTrying')}</div>}
      <div className="sampling-summary" title={t('ageHint').replace('{n}', String(Math.round(threshold / 1000)))}>
        <span>{t('lastSample')}: <strong>{lastSample === null ? t('notSampled') : age === null ? t('sampleTimeUnverified') : t('secondsAgo').replace('{n}', String(age))}</strong></span>
        <span>{lastSample === null ? '—' : formatLocalTs(new Date(lastSample).toISOString())}</span>
        <span className={groups.some(g => groupErrors[g.id]) ? 'has-fault' : ''}>{t('faultsLabel')}: {groups.filter(g => groupErrors[g.id]).length}</span>
      </div>
      {device.mode === 'slave' && <DeviceSlaveStatus deviceId={device.id} />}
      <RecordingIntervalNotice deviceId={device.id} />
      <TabBar tabs={[{ id: 0, label: t('tabLive') }, { id: 1, label: t('liveCurve') }, { id: 2, label: t('tabHistory') }, ...(device.mode === 'slave' ? [] : [{ id: 3, label: t('tabRaw') }, { id: 4, label: t('tabFirmware') }]), { id: 5, label: t('pointCheckTab') }]} active={tab} onChange={next => { if (tab === 0 && next !== 0 && onLeaveDrafts?.('live') === false) return; if (next !== 2) historyNavigation.current!.cancelPending(); setTab(next) }} />
      <AlarmPanel configurationReady={configurationReady} onHistory={onNavigate} t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} now={now} threshold={threshold} />
      {tab === 0 && <LiveTable configurationReady={configurationReady && deviceListReady} draftScope={draftScope} t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} now={now} threshold={threshold} onRefresh={() => onRefresh(device.id)} />}
      {tab === 2 && <HistoryView navigation={historyNavigation.current} memory={queryMemory.current} configurationReady={configurationReady} target={target} t={t} device={device} groups={groups} registers={registers} />}
      {tab === 3 && device.mode !== 'slave' && <RawDataView t={t} device={device} />}
      {tab === 4 && device.mode !== 'slave' && <FirmwareView t={t} device={device} />}
      {tab === 5 && (configurationReady ? <DeferredPointDiagnostics onClose={() => setTab(0)} key={pointCheckContext} deviceId={device.id} points={registers} groups={groups} pointLabels={pointCheckLabels} fetcher={fetchPointDiagnostics} english={t('cancel') === 'Cancel'} /> : <p role="status">{t('pointCheckWaiting')}</p>)}
      <div hidden={tab !== 1}><LiveCurve active={tab === 1} t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} threshold={threshold} /></div>
      {showEdit && <DeviceModal draftScope={draftScope} t={t} initial={device} onClose={() => setShowEdit(false)} onSave={async (f, expected) => { if (!expected) throw new Error(t('operationFailed')); await onEdit(device.id, f, expected); setShowEdit(false) }} />}
    </div>
  )
}

function TabBar({ tabs, active, onChange }: { tabs: { id: number; label: string }[]; active: number; onChange: (id: number) => void }) {
  return (
    <div className="tab-bar">
      {tabs.map(({ id, label }) => (
        <button key={id} className={'tab' + (active === id ? ' active' : '')} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  )
}

function LiveTable({ draftScope, t, device, groups, latest, groupErrors, now, threshold, onRefresh, configurationReady = false }: {
  draftScope?: DraftRegistration; configurationReady?: boolean; t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>; now: number; threshold: number; onRefresh: () => void
}) {
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; group: DeviceGroup }>(null)
  const [writeReg, setWriteReg] = useState<Register | null>(null)
  const [snapshotCapture, setSnapshotCapture] = useState<FrozenLiveObservation | null>(null)
  const snapshot = snapshotCapture?.snapshot ?? null
  const snapshotComparisonKey = useMemo(() => liveSnapshotComparisonKey(device, groups), [device, groups])
  const snapshotComparisonScope = useMemo(() => snapshotComparisonKey === null ? null : Symbol('live-snapshot-comparison'), [snapshotComparisonKey])
  const [settingsReg, setSettingsReg] = useState<(Register & { editBaseline: PointEditBaseline }) | null>(null)
  const { rules: alarmRules, ready: alarmRulesReady, error: alarmRuleError, reading: readingAlarmRules, retry: retryAlarmRules } = useAlarmRules(device.id)
  const [alarmReg, setAlarmReg] = useState<Register | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [columns, setColumns] = useDisplayColumns(device.id)
  const shownColumns = { ...columns, type: columns.type, action: configuring || columns.action }
  const showValue = shownColumns.raw || shownColumns.physical
  const columnCount = 1 + Number(shownColumns.address) + Number(shownColumns.type) + Number(showValue) + Number(shownColumns.action)
  const tableWidth = 220 + (shownColumns.address ? 90 : 0) + (shownColumns.type ? 140 : 0) + (showValue ? 240 : 0) + (shownColumns.action ? 90 : 0)
  const [search, setSearch] = useState('')
  const [pointFilter, setPointFilter] = useState<LivePointFilter>('all')
  const [watchSelection, setWatchSelection] = useState<LiveWatchSelection | null>(null), [watchOnly, setWatchOnly] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('')
  const deviceSlaveId = device.mode === 'slave' ? device.slaveId : undefined
  const sources = pickerSources(groups, deviceSlaveId), activeSource = sources.includes(sourceFilter) ? sourceFilter : '', sourcesKey = sources.join(',')
  useEffect(() => { if (sourceFilter && !sources.includes(sourceFilter)) setSourceFilter('') }, [sourceFilter, sourcesKey])
  const operation = useOperation(t)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleCollapse = (id: number) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const deleteGroup = async (id: number) => {
    if (!configurationReady) { operation.setNotice({ error: true, text: t('cancel') === 'Cancel' ? 'Configuration unverified; no new deletion sent. Re-read and check.' : '配置未核实，本次未发新删除；请重读核对。' }); return }
    const g = groups.find((gg) => gg.id === id)
    if (!window.confirm(t('confirmDeleteGroup').replace('{name}', g?.name ?? String(id)))) return
    let phase = 1
    await operation.run(async () => { await api.del('/api/groups/' + id); phase = 2; onRefresh() }, undefined, error => {
      if (phase === 1 && error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) return error.message
      const english = t('cancel') === 'Cancel'
      return phase === 2
        ? (english ? 'Deletion returned success; page refresh failed. Check the group list; do not repeat automatically.' : '删除请求返回成功，但页面未同步；请核对分组清单，勿自动重删。')
        : (english ? 'Deletion outcome unverified; it may have applied. Check the group configuration; do not repeat automatically.' : '删除结果待核实，可能已生效；请核对分组配置，勿自动重删。')
    })
  }
  const toggleGroupPause = async (id: number) => {
    await operation.run(async () => {
      const group = groups.find(value => value.id === id)
      if (!group) throw new Error('当前分组不可核对，请刷新配置。')
      const expected = captureActivation(device, { ...group, objectId: device.id })
      return saveActivation(expected, expected.isActive ? 0 : 1, api.put, onRefresh)
    }, warnings => [t('operationOk'), ...warnings as readonly string[]].join(' · '))
  }
  const [bookResult, setBookResult] = useState<PointBookResult | null>(null)
  const bookInputRef = useRef<HTMLInputElement>(null)
  const bookOpeningRef = useRef<ReturnType<typeof capturePointBookOpening>>(null), bookAlive = useRef(true)
  const bookCurrentRef = useRef((): ReturnType<typeof capturePointBookOpening> => null)
  bookCurrentRef.current = () => bookAlive.current && configurationReady ? capturePointBookOpening(snapshotComparisonScope, liveSnapshotComparisonKey(device, groups), device.id) : null
  if (!configurationReady) bookOpeningRef.current = null
  useEffect(() => { bookAlive.current = true; return () => { bookAlive.current = false; bookOpeningRef.current = null } }, [])
  const chooseBook = () => { if (operation.busy) return; bookOpeningRef.current = bookCurrentRef.current(); if (bookOpeningRef.current) bookInputRef.current?.click() }
  const uploadBook = async (e: any) => {
    const file = e?.target?.files?.[0]
    if (e?.target) e.target.value = ''
    const opening = bookOpeningRef.current; bookOpeningRef.current = null
    if (!file || !device || !bookAlive.current) return
    const changed = () => operation.setNotice({ error: true, text: t('cancel') === 'Cancel' ? 'Import target or loaded definitions changed or are unverified. No import was sent for this selection; prior requests need separate verification. Check the target and choose the file again.' : '导入目标或已加载点表已变化或未核实，本次选择未发出导入；先前请求结果仍须单独核对。请核对目标后重新选择文件。' })
    if (!pointBookOpeningMatches(opening, bookCurrentRef.current())) { changed(); return }
    if (!window.confirm(pointBookReplacementPrompt(file.name, device, groups, t('cancel') === 'Cancel'))) return
    if (!pointBookOpeningMatches(opening, bookCurrentRef.current())) { changed(); return }
    const targetLabel = `${device.name} (#${device.id}) · ${device.transport.toUpperCase()} ${device.transport === 'rtu' ? device.serialPath ?? '?' : device.ip + ':' + device.port}`
    await operation.run(async () => {
      setBookResult(null)
      let report: PointBookReport
      try { report = await sendPointBook(device.id, file) }
      catch (error) {
        const message = error instanceof InvalidPointBookReportError ? t('pointBookInvalidReport') : error instanceof Error ? error.message : String(error)
        setBookResult({ fileName: file.name, targetLabel, report: null, error: message })
        throw new Error(message)
      }
      setBookResult({ fileName: file.name, targetLabel, report })
      onRefresh()
      if (report.errors.length) throw new Error(t(pointBookReportKind(report) === 'uncertain' ? 'pointBookUncertain' : 'pointBookRejected'))
    })
    if (bookInputRef.current) bookInputRef.current.value = ''
  }
  const views = useMemo(() => buildRegViews(groups, latest, device.id, device.mode === 'slave' ? device.slaveId : undefined), [groups, latest, device.id, device.mode, device.slaveId])
  const pointStates = useMemo(() => evaluateLivePoints(groups, views, latest, device, alarmRules, groupErrors, now, threshold), [groups, views, latest, device.id, device.isActive, device.mode, device.slaveId, alarmRules, groupErrors, now, threshold])
  const baseFilteredPoints = useMemo(() => livePointFilterResult(groups, pointStates, search, activeSource, pointFilter, deviceSlaveId), [groups, pointStates, search, activeSource, pointFilter, deviceSlaveId])
  const watchResult = liveWatchResult(watchSelection, snapshotComparisonScope, watchOnly, baseFilteredPoints.visibleIds)
  const filteredPoints = { ...baseFilteredPoints, visibleIds: watchResult.visibleIds }
  const hasPointFilters = !!search.trim() || !!activeSource || pointFilter !== 'all' || watchOnly
  const pointFilterKey = JSON.stringify([search.trim(), activeSource, pointFilter, watchOnly, watchResult.ids.size ? [...watchResult.ids] : null])
  // Summarize the full group before applying search or issue filters.
  const summaries = new Map(groups.map(g => {
    const state = pointHealth(Array.from({ length: g.quantity }, (_, i) => sourceSample(latest, device.id, areaForFunctionCode(g.functionCode), g.startAddress + i, device.mode === 'slave' ? device.slaveId : g.slaveId)), now, threshold, !device.isActive || !g.isActive, !!groupErrors[g.id])
    const incomplete = state.missing || g.registers.some(r => views.get(r.id)?.invalid)
    const status = !device.isActive || !g.isActive ? 'pausedData' : groupErrors[g.id] ? 'groupCommunicationError' : state.timestamp === null ? 'notSampled' : incomplete ? 'groupPartialData' : state.stale ? 'groupOldValues' : 'fresh'
    return [g.id, { ...state, status }] as const
  }))
  const shown = groups.map(g => ({ ...g, registers: g.registers.filter(r => filteredPoints.visibleIds.has(r.id)) })).filter(g => g.registers.length > 0 || !hasPointFilters)
  return (
    <div>

      <div className="observation-toolbar">
        <div className="seg"><button className={!configuring ? 'selected' : ''} aria-pressed={!configuring} onClick={() => setConfiguring(false)}>{t('observe')}</button><button className={configuring ? 'selected' : ''} aria-pressed={configuring} onClick={() => setConfiguring(true)}>{t('configure')}</button></div>
        <ColumnControl t={t} columns={columns} configuring={configuring} onChange={setColumns} />
        <button className="btn" type="button" disabled={!filteredPoints.visibleIds.size} onClick={() => { try { const value = captureLiveSnapshot({ device, groups, visibleIds: filteredPoints.visibleIds, views, states: pointStates, latest, filters: { search, source: activeSource, mode: pointFilter }, rulesReady: alarmRulesReady, observedAt: now, capturedAt: Date.now(), thresholdMs: threshold }); setSnapshotCapture(Object.freeze({ snapshot: value, scope: snapshotComparisonScope })) } catch (error) { operation.setNotice({ error: true, text: error instanceof Error ? error.message : t('operationFailed') }) } }}>{t('cancel') === 'Cancel' ? 'Freeze current matches' : '冻结当前筛选结果'}</button>
      </div>
      <LivePointFilters extraFiltered={watchOnly} search={search} source={activeSource} sources={sources} mode={pointFilter} counts={filteredPoints.counts} rulesReady={alarmRulesReady} ruleError={!!alarmRuleError} readingRules={readingAlarmRules} onRetryRules={retryAlarmRules} onSearch={setSearch} onSource={setSourceFilter} onMode={setPointFilter} onClear={() => { setSearch(''); setSourceFilter(''); setPointFilter('all'); setWatchOnly(false) }} english={t('cancel') === 'Cancel'} />
      <LiveWatchList selection={watchSelection} scope={snapshotComparisonScope} only={watchOnly} matches={baseFilteredPoints.visibleIds} groups={groups} deviceSlaveId={deviceSlaveId} t={t} english={t('cancel') === 'Cancel'} onSelect={(scope, ids) => { const selected = captureLiveWatch(scope, ids, groups); if (selected) { setWatchSelection(selected); setWatchOnly(true) } else if (!ids.size) { setWatchSelection(null); setWatchOnly(false) } else { operation.setNotice({ error: true, text: t('cancel') === 'Cancel' ? 'Watch list was not applied: point identity or count could not be verified. Check the point definitions and choose again (up to 32 points).' : '观察清单未应用：点位身份或数量无法核对，请核对点表后重新选择（最多32点）。' }) } }} onOnly={setWatchOnly} onClear={() => { setWatchSelection(null); setWatchOnly(false) }} />
      <LiveSnapshotComparison current={snapshotCapture} scope={snapshotComparisonScope} english={t('cancel') === 'Cancel'} />
      {snapshot && <LiveSnapshotPanel key={snapshot.capturedAt} snapshot={snapshot} close={() => setSnapshotCapture(null)} english={t('cancel') === 'Cancel'} />}
      {configuring && <div className="toolbar">
        <button className="btn primary" onClick={() => setModal({ mode: 'add' })}>＋ {t('newGroup')}</button>
        <button className="btn" disabled={operation.busy || !configurationReady || !snapshotComparisonScope} onClick={chooseBook}>⬆ {t('importPointBook')}</button>
        <button className="btn" onClick={() => window.open('/api/monitor_objects/' + device.id + '/points/book')}>⬇ {t('exportPointBook')}</button>
        <input ref={bookInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => void uploadBook(e)} />
      </div>}
      {bookResult && <PointBookImportResult result={bookResult} t={t} onDismiss={() => setBookResult(null)} />}
      {shown.map((g) => {
        const summary = summaries.get(g.id)!
        return (
        <div key={g.id} className="group-block">
          <div className="group-data-summary">
            <span>{t('pointStatus')}: <strong className={summary.status === 'fresh' ? 'group-data-fresh' : summary.status === 'groupCommunicationError' ? 'has-fault' : ''}>{t(device.mode === 'slave' && summary.status === 'groupCommunicationError' ? 'slaveServiceError' : summary.status)}</strong></span>
            <span title={t('groupTimeHint') + (summary.timestamp === null ? '' : ' · ' + formatLocalTs(new Date(summary.timestamp).toISOString()))}>{t('updatedAt')}: <strong>{summary.ageSeconds === null ? '—' : t('secondsAgo').replace('{n}', String(summary.ageSeconds))}</strong></span>
          </div>
          <div className="group-head">
            <button className="group-collapse" disabled={hasPointFilters} aria-label={g.name} aria-expanded={hasPointFilters || !collapsed.has(g.id)} onClick={() => toggleCollapse(g.id)}><span className={'group-chevron' + (!hasPointFilters && collapsed.has(g.id) ? ' is-collapsed' : '')}>▾</span></button>
            <button className="group-name group-name-toggle" disabled={hasPointFilters} aria-expanded={hasPointFilters || !collapsed.has(g.id)} onClick={() => toggleCollapse(g.id)}>{g.name}</button>
            <span className="kv">FC{g.functionCode} · 从站 {device.mode === 'slave' ? device.slaveId : g.slaveId} · 起始 {g.startAddress} · {g.quantity} 个</span>
            {groupErrors[g.id] && <span className="group-error" title={groupErrors[g.id]}>⚠ {groupErrors[g.id] === 'Disconnected' ? t('groupDisconnected') : groupErrors[g.id]}</span>}
            <div style={{ flex: 1 }} />
            <button className="btn" disabled={operation.busy} onClick={() => toggleGroupPause(g.id)}>{g.isActive ? t('pause') : t('resume')}</button>
            {configuring && <button className="btn" onClick={() => { try { setModal({ mode: 'edit', group: fullGroupForEditing(groups, g.id) }) } catch (e) { operation.setNotice({ error: true, text: e instanceof Error ? e.message : t('operationFailed') }) } }}>{t('edit')}</button>}
            {configuring && <button className="btn danger" disabled={operation.busy || !configurationReady} onClick={() => deleteGroup(g.id)}>{t('deleteGroup')}</button>}
          </div>
          <GroupFold collapsed={!hasPointFilters && collapsed.has(g.id)}>{() => (<div className="register-table-scroll" key={pointFilterKey}><table className="reg realtime-table" style={{ minWidth: tableWidth }}>
            <colgroup>{shownColumns.address && <col className="rt-address" />}<col className="rt-description" />{shownColumns.type && <col className="rt-type" />}{showValue && <col className="rt-value" />}{shownColumns.action && <col className="rt-action" />}</colgroup>
            <thead><tr>{shownColumns.address && <th>{t('colAddr')}</th>}<th>{t('colAlias')}</th>{shownColumns.type && <th>{t('colType')}</th>}{showValue && <th className="rt-numeric-cell"><div className="rt-value-stack"><div className="rt-value-line"><span className="rt-value-heading">{t('colValue')}</span></div></div></th>}{shownColumns.action && <th className="rt-action-cell">{t(configuring ? 'pointSettings' : 'write')}</th>}</tr></thead>
            <VirtualTableBody items={g.registers} columns={columnCount}>
              {(r) => {
                const rv = views.get(r.id)
                const { health: state, alarmActive } = pointStates.get(r.id)!
                const writable = rv?.writable && (device.mode === 'slave' || [1, 3].includes(g.functionCode))
                return (
                  <tr key={r.id} data-register-id={r.id}>
                    {shownColumns.address && <td className="kv" data-label={t('colAddr')}>{r.startAddress}</td>}
                    <td className="rt-description-cell">{configuring ? <AliasCell point={r} group={g} device={device} placeholder={t('colAlias')} put={(url, body, signal) => request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })} get={(url, signal) => request(url, { signal })} onRefresh={onRefresh} /> : <span className="rt-name" title={`${r.alias || '—'} · #${r.id} · FC${g.functionCode} · ${r.startAddress}`}>{r.alias || '—'}</span>}</td>
                    {shownColumns.type && <td data-label={t('colType')}><span className="point-type">{r.dataType}</span></td>}
                    {showValue && <td data-label={t('colValue')} className={'value rt-numeric-cell rt-stacked-cell' + (state.stale ? ' stale-value' : '') + (alarmActive ? ' alarm-value' : '')}>
                      <div className="rt-value-stack">
                        {shownColumns.raw && <div className="rt-value-line" title={(rv?.value ?? '—') + '\n' + (rv?.covered ? t('valueCovered') : rv?.invalid ? t('valueShort') : writable ? t('valueHint') : t('readOnly'))} onDoubleClick={writable ? () => setWriteReg(r) : undefined}>
                          <span className="rt-value-label">{t('colRawValue')}</span>
                          <ValueReading value={rv?.value ?? null} fresh={!state.stale && !rv?.invalid && !rv?.covered} identity={JSON.stringify([r.id, r.dataType, r.decimalPlaces])} />
                        </div>}
                        {shownColumns.physical && <div className="rt-value-line rt-physical-line" title={(rv?.label ? rv.label + '\n' : '') + (rv?.covered ? t('valueCovered') : rv?.invalid ? t('valueShort') : rv?.physical?.issue ? t(({ precision: 'physicalPrecision', invalid: 'physicalInvalid', raw: 'physicalRaw' })[rv.physical.issue]) : t('physicalFormula').replace('{factor}', String(r.factor ?? 1)).replace('{offset}', String(r.offset ?? 0)) + (r.unit ? ' · ' + r.unit : ''))}>
                          <span className="rt-value-label">{t('colPhysicalValue')}</span>
                          <ValueReading value={rv?.physical?.value ?? null} fresh={!state.stale && !rv?.invalid && !rv?.covered} identity={JSON.stringify([r.id, r.dataType, r.decimalPlaces, r.factor, r.offset, r.unit])} />
                          <span className="rt-value-suffix">
                            {rv?.physical?.value != null && r.unit && <span className="rt-unit">{r.unit}</span>}
                            {rv?.label && <span className="rt-inline-enum">{rv.label}</span>}
                          </span>
                        </div>}
                      </div>
                    </td>}
                    {shownColumns.action && <td className="rt-action-cell" data-label={t(configuring ? 'pointSettings' : 'write')}>{configuring ? <div className="point-config-actions"><button className="btn" disabled={rv?.covered} title={rv?.covered ? t('valueCovered') : t('pointSettings')} onClick={() => { try { setSettingsReg({ ...r, editBaseline: capturePointEditBaseline(r, g, device) }) } catch { operation.setNotice({ error: true, text: t('operationFailed') }) } }}>{t('pointSettingsAction')}</button><button className="btn" disabled={rv?.covered} title={t('alarmRules')} onClick={() => setAlarmReg(r)}>{t('alarmLabel')}</button></div> : writable ? <button className="btn" onClick={() => setWriteReg(r)}>{t('write')}</button> : <span className="kv">{[2, 4].includes(g.functionCode) ? t('readOnly') : '—'}</span>}</td>}
                  </tr>
                )
              }}
            </VirtualTableBody>
          </table></div>)}</GroupFold>
        </div>
      )})}
      {shown.length === 0 && <div className="hist-empty">{t(groups.length === 0 ? 'noRegisters' : 'noMatchingPoints')}</div>}
      {modal && <GroupModal draftScope={draftScope} creationReady={configurationReady} t={t} device={device} initial={modal.mode === 'edit' ? modal.group : null} onClose={() => setModal(null)} onSaved={warnings => { setModal(null); onRefresh(); operation.setNotice({ error: false, text: [t('operationOk'), ...warnings].join(' · ') }) }} get={(url, signal) => request(url, { signal })} put={api.put} create={api.post} />}
      {alarmReg && <AlarmPanel t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} now={now} threshold={threshold} point={alarmReg} onClose={() => setAlarmReg(null)} />}
      {settingsReg && <PointSettingsEditor draftScope={draftScope} guarded name={settingsReg.alias || '#' + settingsReg.id} address={settingsReg.startAddress} settings={settingsReg} typeGroups={TYPE_GROUPS} available={(() => { const group = groups.find(g => g.id === settingsReg.groupId); return group ? group.startAddress + group.quantity - settingsReg.startAddress : 0 })()} t={t} onClose={() => setSettingsReg(null)} onSave={async fields => {
        const warnings = await saveGuardedPointSettings(settingsReg.editBaseline, fields, api.put)
        onRefresh(); operation.setNotice({ error: false, text: [t('operationOk'), ...warnings].join(' · ') })
      }} />}
      {writeReg && <WriteModal t={t} deviceName={device.name} local={device.mode === 'slave'} currentValue={views.get(writeReg.id)?.value ?? '—'} reg={writeReg} onClose={() => setWriteReg(null)} onSaved={() => { setWriteReg(null); operation.setNotice({ error: false, text: t('writeOk') }) }} />}
    </div>
  )
}

function GroupFold({ collapsed, children }: { collapsed: boolean; children: () => React.ReactNode }) {
  const [retained, setRetained] = useState(!collapsed)
  useEffect(() => {
    if (!collapsed) { setRetained(true); return }
    // Unmount after the short exit transition so hidden rows stop updating.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRetained(false); return }
    const timer = window.setTimeout(() => setRetained(false), 180)
    return () => window.clearTimeout(timer)
  }, [collapsed])
  return <div className={'group-fold' + (collapsed ? ' is-collapsed' : '')} aria-hidden={collapsed}>
    <div className="group-fold-inner" ref={el => { if (el) { if (collapsed) el.setAttribute('inert', ''); else el.removeAttribute('inert') } }}>
      {(!collapsed || retained) && children()}
    </div>
  </div>
}


function WriteModal({ t, reg, deviceName, currentValue, local, onClose, onSaved }: { t: T; reg: Register; deviceName: string; currentValue: string; local?: boolean; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [method, setMethod] = useState<'single' | 'multiple'>('multiple')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const width = registerWidth(reg.dataType)
  const isRaw = isHexType(reg.dataType) || isBinType(reg.dataType)
  const write = async () => {
    if (value.trim() === '') { setErr(t('writeErrEmpty')); return }
    let num: string | number
    try {
      num = registerWritePayloadValue(reg.dataType, value)
    } catch (error) { setErr((error as Error).message); return }
    if (typeof num === 'number' && !Number.isFinite(num)) { setErr(t('writeErrNaN')); return }
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
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{local ? '设置从站点位值' : t('writeReg')}</h3>
        <div className="write-context"><strong>{deviceName}</strong><span>{t('currentValue')}: {currentValue}</span><small>{local ? '修改本设备的从站内存，不向外部设备写入。' : t('pointWriteHint')}</small></div>
        <div className="kv" style={{ marginBottom: 10 }}>{reg.alias ?? reg.id} · {t('colAddr')} {reg.startAddress} · {reg.dataType}{width > 1 ? '（' + width + ' 寄存器）' : ''}</div>
        <label>{t('valuePh')}</label>
        <input value={value} onChange={(e) => { setValue(e.target.value); setErr(null); setOk(false) }} autoFocus placeholder={isHexType(reg.dataType) ? '0x1234' : isBinType(reg.dataType) ? '0b1010' : t('valuePh')} />
        {isRaw && <div className="kv">{isHexType(reg.dataType) ? '输入十六进制整数，可带 0x 前缀。' : '输入二进制整数，可带 0b 前缀。'} {width * 16} 位无符号值；直接写入原始数据，不应用系数或偏移。</div>}
        {!local && <><label>{t('functionCode')}</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'single' | 'multiple')} disabled={width > 1}>
          <option value="multiple">{reg.functionCode === 1 ? 'FC05' : t('fc16')}</option>
          {width === 1 && reg.functionCode !== 1 && <option value="single">{t('fc06')}</option>}
        </select></>}
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

function deriveHistoryRows(pts: HistoryPoint[], registers: Register[], selectedRegisters: Register[], valueMode: ValueMode): Array<{ ts: string; values: Record<number, string> }> {
  const buckets = new Map<string, HistoryPoint[]>()
  for (const p of pts) { const ts = p.timestampMs != null ? new Date(p.timestampMs).toISOString() : p.ts; if (!buckets.has(ts)) buckets.set(ts, []); buckets.get(ts)!.push(p) }
  return [...buckets].map(([ts, points]) => {
    const values: Record<number, string> = {}
    for (const r of selectedRegisters) {
      const decoded = decodeHistoricalSample(r, points.filter(p => p.area === areaForFunctionCode(r.functionCode)))
      const d = decoded.value
      let text = '—'
      if (d != null) {
        if (isHexType(r.dataType) || isBinType(r.dataType)) text = valueMode === 'physical' ? '—' : formatRegisterValue(r.dataType, decoded.words)
        else if (valueMode === 'physical') {
          const physical = physicalValue(d, r).value, label = enumLabelOf(r, d)
          text = (physical == null ? '—' : physical + (r.unit ? ' ' + r.unit : '')) + (label ? ' → ' + label : '')
        } else text = displayNumber(d)
      }
      values[r.id] = text + ' [' + historyVerificationLabel[decoded.verification] + ']'
    }
    return { ts, values }
  })
}

interface HistoryPayload { points: HistoryPoint[]; series?: HistorySeries[]; sourceSamples?: number; displayedSamples?: number; downsampled?: boolean; total: number }
function HistoryView({ navigation, memory, configurationReady, target, t, device, groups, registers }: { navigation: HistoryNavigation; memory: HistoryQueryMemory; configurationReady: boolean; target: DataTarget | null; t: T; device: Device; groups: DeviceGroup[]; registers: Register[] }) {
  const [mode, setMode] = useState<'table' | 'chart'>('table')
  const [valueMode, setValueMode] = useValueMode('ps-history-value-mode-' + device.id)
  const [range, setRange] = useState(() => historyPresetRange(60, Date.now(), 'local'))
  const [preset, setPreset] = useState<number | null>(60)
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [readState, setReadState] = useState<HistoryReadState<HistoryPayload> | null>(null)
  const [curveRange, setCurveRange] = useState<{ start: number; end: number } | null>(null)
  const queryTask = useRef<HistoryQueryTask | null>(null)
  const [exportRequest, setExportRequest] = useState<HistoryExportRequest | null>(null)
  const [selected, setSelected] = useRegisterSelection(device.id, registers)
  const [navigationRevision, setNavigationRevision] = useState(0)
  const [navigationNotice, setNavigationNotice] = useState<{ kind: 'waiting' | 'missing' | 'changed' | 'invalid'; id?: number } | null>(null)
  useEffect(() => {
    const action = navigation.consume(target, device.id, registers.map(r => r.id), configurationReady, registers)
    if (!target || target.view !== 'history') setNavigationNotice(null)
    if (!action) return
    if (action.invalid) { setNavigationNotice({ kind: 'invalid' }); setSelected(new Set()); return }
    if (action.range) {
      const nextRange = action.range
      if (action.valueMode) setValueMode(action.valueMode)
      setRange(previous => historyTimeRange(nextRange.start, nextRange.end, previous.zone))
      setPreset(null); setPage(0); setMode('chart'); setCurveRange(null); setNavigationRevision(value => value + 1); setRefresh(value => value + 1); setNavigationNotice(null)
    }
    if (action.focus) {
      setSelected(action.focus.state === 'found' ? new Set([action.focus.id]) : new Set())
      setNavigationNotice(action.focus.state === 'found' ? null : { kind: action.focus.state, id: action.focus.id })
    }
  }, [navigation, target, device.id, registers, configurationReady])
  const cancelNavigation = () => { navigation.cancelPending(); setNavigationNotice(null) }
  const selectedRegisters = registers.filter(r => selected.has(r.id))
  const pointLabels = useMemo(() => buildPointLabels(registers, groups, t, device.mode === 'slave' ? device.slaveId : undefined), [registers, groups, t, device.mode, device.slaveId])
  const { start: startMs, end: endMs, valid } = useMemo(() => resolveHistoryTimeRange(range), [range])
  const memoryContext = useMemo(() => queryMemoryContext(device, registers), [registers, device.id, device.mode, device.transport, device.ip, device.port, device.serialPath, device.slaveId, device.baudRate, device.parity, device.stopBits, device.dataBits, device.flowControl])
  const contextKey = useMemo(() => historyReadContextKey(device, groups, registers), [groups, registers, device.id, device.mode, device.slaveId])
  const exportContext = useMemo(() => configurationReady && contextKey !== null && memoryContext.deviceKey !== null ? { definitions: contextKey, device: memoryContext.deviceKey } : null, [configurationReady, contextKey, memoryContext.deviceKey])
  const exportContextRef = useRef(exportContext); exportContextRef.current = exportContext
  useEffect(() => { setPage(0); if (!configurationReady || contextKey === null) setCurveRange(null) }, [contextKey, configurationReady])
  const { start: queryStart, end: queryEnd } = historyQueryRange(mode === 'chart' && curveRange ? curveRange : { start: startMs, end: endMs })
  const selectionKey = [...selected].sort((a, b) => a - b).join(',')
  const curveSelection = useMemo(() => mode === 'chart' && configurationReady && contextKey !== null ? planHistoryCurve(groups, registers, selectionKey ? selectionKey.split(',').map(Number) : []) : { registers: [], entries: [] }, [mode, configurationReady, contextKey, groups, registers, selectionKey])
  const curveSelected = useMemo(() => new Set(curveSelection.registers.map(r => r.id)), [curveSelection])
  const requestSelectionKey = mode === 'chart' ? curveSelection.registers.map(r => r.id).sort((a, b) => a - b).join(',') : selectionKey
  const noCurvePoints = mode === 'chart' && selected.size > 0 && curveSelection.registers.length === 0
  useEffect(() => { if (noCurvePoints) setCurveRange(null) }, [noCurvePoints])
  const plan = useMemo(() => valid && configurationReady && contextKey !== null ? historyQueryPlan({ objectId: device.id, start: queryStart, end: queryEnd, mode, page, registerIds: requestSelectionKey ? requestSelectionKey.split(',').map(Number) : [], contextKey, revision: refresh }) : null, [device.id, queryStart, queryEnd, valid, configurationReady, contextKey, mode, page, requestSelectionKey, refresh])
  const { data, status: currentStatus, error, contextChanged } = historyReadView(plan, readState)
  useEffect(() => {
    const task = startHistoryQuery<HistoryPayload>(plan, async (url, signal) => {
      const response = await request(url, { signal }), points: HistoryPoint[] = response.points ?? []
      return { ...response, points, series: response.series?.map((s: any) => ({ ...s, gapMs: s.gapMs ?? Infinity })), total: response.total ?? points.length }
    }, event => setReadState(previous => reduceHistoryRead(previous, plan, event)))
    queryTask.current = task
    return () => { task.dispose(); if (queryTask.current === task) queryTask.current = null }
  }, [plan])
  useEffect(() => { setCurveRange(null) }, [startMs, endMs])
  const applyPreset = (minutes: number) => {
    const now = Date.now()
    setRange(previous => historyPresetRange(minutes, now, previous.zone))
    setPreset(minutes); setCurveRange(null); setPage(0); setRefresh(v => v + 1)
  }
  const rows = useMemo(() => deriveHistoryRows(data?.points ?? [], registers, selectedRegisters, valueMode), [data, registers, selected, valueMode])
  const beginExport = (scope: HistoryExportRequest['scope']) => {
    if (!exportContext || !valid || !selectedRegisters.length) return
    const exportRange = scope === 'viewport' ? (mode === 'chart' ? curveRange : null) : { start: startMs, end: endMs }
    if (!exportRange) return
    setExportRequest(captureHistoryExport(device.id, exportRange, selectedRegisters.map(r => r.id), localTzOffsetMin(), scope, exportContext))
  }
  const errorText = error instanceof HistoryQueryTimeoutError ? t('histTimeout') : error instanceof Error ? error.message : error == null ? null : String(error)
  return <div className="history-view">
    <div className="toolbar">
      <div className="seg"><button className={mode === 'table' ? 'selected' : ''} onClick={() => { setMode('table'); setPage(0) }}>{t('histTable')}</button><button className={mode === 'chart' ? 'selected' : ''} onClick={() => { setMode('chart'); setPage(0) }}>{t('tabCurve')}</button></div>
      <ValueModeControl t={t} value={valueMode} onChange={setValueMode} />
      <RegisterSelectButton t={t} groups={groups} deviceSlaveId={device.mode === 'slave' ? device.slaveId : undefined} selected={selected} onApply={ids => { cancelNavigation(); setSelected(ids) }} />
      <div style={{ flex: 1 }} />
      <button className="btn" disabled={!exportContext || !valid || selected.size === 0 || currentStatus === 'loading'} onClick={() => beginExport('full')}>{t('histExportFull')}</button>
      {mode === 'chart' && <button className="btn" disabled={!exportContext || !valid || selected.size === 0 || !curveRange || currentStatus !== 'done'} onClick={() => beginExport('viewport')}>{t('histExportViewport')}</button>}
    </div>
    <p className="chart-hint" role="note">{t('histIntegrityHint')}</p>
    <HistoryReadNotice reason={!configurationReady ? 'waiting' : contextKey === null ? 'invalid' : contextChanged ? 'changed' : null} english={t('cancel') === 'Cancel'} />
    {target?.deviceId === device.id && target.view === 'history' && target.pointSource === undefined && <p className="chart-hint" role="status">{t('cancel') === 'Cancel' ? 'Link source unverified; current configuration only.' : '引用来源未核验；仅按当前配置。'}</p>}
    {navigationNotice && <p className={'chart-hint' + (navigationNotice.kind !== 'waiting' ? ' warn' : '')} role={navigationNotice.kind === 'waiting' ? 'status' : 'alert'}>{t(navigationNotice.kind === 'waiting' ? 'histNavigationWaiting' : navigationNotice.kind === 'missing' ? 'histNavigationMissing' : navigationNotice.kind === 'changed' ? 'histNavigationChanged' : 'histNavigationInvalid').replace('{id}', String(navigationNotice.id ?? ''))}</p>}
    {valueMode === 'physical' && <p className="chart-hint">{t('physicalHistoryHint')}</p>}
    <div className="hist-quick history-presets">
      {[5, 30, 60, 360, 1440, 0].map(minutes => <button key={minutes} className={'btn' + (preset === minutes ? ' selected' : '')} onClick={() => applyPreset(minutes)}>{minutes === 0 ? t('histToday') + (t('cancel') === 'Cancel' ? ' (local)' : '（本地）') : minutes < 60 ? t('histMinutes').replace('{n}', String(minutes)) : t('histHours').replace('{n}', String(minutes / 60))}</button>)}
    </div>
    <HistoryTimeRange range={range} onEdit={(field, text) => { const next = editHistoryTime(range, field, text); if (next === range) return; setPreset(null); setRange(next); setCurveRange(null); setPage(0) }} onZone={zone => setRange(previous => changeHistoryInputZone(previous, zone))} english={t('cancel') === 'Cancel'}>
      <button className="btn primary" disabled={!plan || currentStatus === 'loading'} onClick={() => { cancelNavigation(); setRefresh(v => v + 1) }}>{t(currentStatus === 'loading' ? 'histLoading' : 'histQuery')}</button>
      {currentStatus === 'loading' && <button className="btn" onClick={() => { cancelNavigation(); queryTask.current?.cancel() }}>{t('histCancel')}</button>}
    </HistoryTimeRange>
    <HistoryQueryMemoryPanel memory={memory} context={memoryContext} ready={configurationReady} canSave={valid && selectedRegisters.length > 0} canViewport={valid && mode === 'chart' && !!curveRange} english={t('cancel') === 'Cancel'}
      onSave={(name, scope) => {
        const captured = scope === 'viewport' ? (mode === 'chart' ? curveRange : null) : { start: startMs, end: endMs }
        if (!captured) throw new QueryMemoryError('invalid-query')
        return memory.save(name, { ...captured, registerIds: [...selected], mode, valueMode, inputZone: range.zone, scope }, memoryContext, configurationReady)
      }}
      onRestore={id => memory.restore(id, memoryContext, configurationReady, saved => {
        cancelNavigation(); queryTask.current?.cancel()
        setRange(historyTimeRange(saved.start, saved.end, saved.inputZone)); setSelected(new Set(saved.points.map(p => p.id)))
        setMode(saved.mode); setValueMode(saved.valueMode); setPage(0); setPreset(null); setCurveRange(null)
        setNavigationRevision(value => value + 1); setRefresh(value => value + 1)
      })} />
    {mode === 'chart' && configurationReady && contextKey !== null && <HistoryCurveSelection plan={curveSelection} pointLabels={pointLabels} onTable={() => { cancelNavigation(); setMode('table'); setPage(0) }} english={t('cancel') === 'Cancel'} />}
    {mode === 'chart' && currentStatus === 'done' && data?.sourceSamples !== undefined && <p className="chart-hint" role="status">{t('histCoverage').replace('{source}', String(data.sourceSamples)).replace('{shown}', String(data.displayedSamples))} · {t(data.downsampled ? 'histSampled' : 'histOriginal')}</p>}
    {valid && mode === 'chart' && currentStatus === 'done' && data?.series && <HistoryQualitySummary series={data.series} registers={registers} pointLabels={pointLabels} t={t} />}
    {!valid ? <div className="hist-empty warn">{t('histRangeInvalid')}</div> : !configurationReady || contextKey === null || noCurvePoints ? null : mode === 'chart' ? <ChartBody queryContextKey={contextKey} key={navigationRevision} pointLabels={pointLabels} sourceSeries={data?.series} onViewportChange={view => { cancelNavigation(); setCurveRange(view) }} valueMode={valueMode} t={t} registers={registers} selected={curveSelected} pts={data?.points ?? []} status={currentStatus} error={errorText} range={{ start: startMs, end: endMs }} /> : <>
      {currentStatus === 'loading' && <div className="hist-empty" role="status">{t('histLoading')}</div>}
      <HistoryTableBody pointLabels={pointLabels} t={t} rows={rows} selectedRegisters={selectedRegisters} status={currentStatus} error={errorText} page={page} total={data?.total ?? 0} pageSize={200} onPageChange={setPage} />
    </>}
    {exportRequest && <HistoryExportModal request={exportRequest} t={t} contextCurrent={historyExportContextMatches(exportRequest, exportContext)} onClose={() => setExportRequest(null)} onPick={(format, signal) => downloadHistoryExport(format, exportRequest, signal, () => exportContextRef.current)} />}
  </div>
}

function HistoryTableBody({ pointLabels, t, rows, selectedRegisters, status, error, page, total, pageSize, onPageChange }: { t: T; rows: Array<{ ts: string; values: Record<number, string> }>; selectedRegisters: Register[]; status: 'idle' | 'loading' | 'done' | 'error'; error: string | null; page: number; total: number; pageSize: number; onPageChange: (page: number) => void; pointLabels: Map<number, PointLabelData> }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(0, page), totalPages - 1)
  const pageOutOfRange = page > 0 && page >= totalPages
  const shown = rows
  if (!selectedRegisters.length) return <div className="hist-empty">{t('histNoRegs')}</div>

  return (
    <>
      {status === 'done' && (totalPages > 1 || page > 0) && <HistoryPaginationNotice outOfRange={pageOutOfRange} onRestart={() => onPageChange(0)} english={t('cancel') === 'Cancel'} />}
      {status === 'idle' && <div className="hist-empty" role="status">{t('histCancelled')}</div>}
      {status === 'done' && rows.length === 0 && !pageOutOfRange && <div className="hist-empty">{t('histEmpty')}</div>}
      {status === 'error' && <div className="hist-empty warn">{t('histError')} {error}</div>}
      {status === 'done' && rows.length > 0 && (
        <>
          <div className="history-table-scroll" tabIndex={0} aria-label={t('histTable')}><table className="reg hist-table">
            <thead><tr><th>{t('colTime')}</th>{selectedRegisters.map(r => <th key={r.id}><PointLabel label={pointLabels.get(r.id)!} /></th>)}</tr></thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={i}><td className="kv" title={row.ts}>{chartCursorLabel(Date.parse(row.ts))}</td>{selectedRegisters.map(r => <td key={r.id} className="value">{row.values[r.id] ?? '—'}</td>)}</tr>
              ))}
            </tbody>
          </table></div>
          <div className="pager">
            <span className="kv">{t('histTotal').replace('{n}', String(total))}</span>
            <button className="btn" onClick={() => onPageChange(0)} disabled={currentPage <= 0}>{t('histFirst')}</button>
            <button className="btn" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 0}>{t('histPrev')}</button>
            <span className="kv">{t('histPage').replace('{x}', String(currentPage + 1)).replace('{y}', String(totalPages))}</span>
            <button className="btn" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages - 1}>{t('histNext')}</button>
            <button className="btn" onClick={() => onPageChange(totalPages - 1)} disabled={currentPage >= totalPages - 1}>{t('histLast')}</button>
          </div>
        </>
      )}
    </>
  )
}

const CHART_COLORS = ['#4176e6', '#22c55e', '#f59e0b', '#ec1313', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6']
function niceStep(range: number, target: number): number {
  const rough = range / target
  if (!Number.isFinite(rough) || rough <= 0) return NaN
  const pow = 10 ** Math.floor(Math.log10(rough))
  if (!Number.isFinite(pow) || pow <= 0) return NaN
  const n = rough / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}
function yTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || !Number.isFinite(count) || count < 1 || count > 100) return []
  if (min === max) return [min]
  const step = niceStep(max - min, count)
  if (!Number.isFinite(step) || step <= 0) return [min, max]
  const start = Math.ceil(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  if (!Number.isFinite(start) || !Number.isSafeInteger(n) || n < 0 || n > 100) return [min, max]
  const out: number[] = []
  for (let i = 0; i < n; i++) { const value = Number((start + i * step).toPrecision(12)); if (Number.isFinite(value) && !out.includes(value)) out.push(value) }
  return out.length ? out : [min, max]
}
function tickNum(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const r = v === 0 ? 0 : v
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


const LiveCurve = memo(function LiveCurve({ active, t, device, groups, latest, groupErrors, threshold }: {
  active: boolean; t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>; threshold: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [valueMode, setValueMode] = useValueMode('ps-live-value-mode-' + device.id)
  useEffect(() => {
    if (!expanded) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [expanded])
  const numericGroups = useMemo(() => groups.map(g => {
    let end = -1
    return { ...g, registers: [...g.registers].sort((a, b) => a.startAddress - b.startAddress).filter(r => {
      if (r.startAddress < end) return false
      end = r.startAddress + registerWidth(r.dataType)
      return end <= g.startAddress + g.quantity && !isHexType(r.dataType) && !isBinType(r.dataType)
    }) }
  }), [groups])
  const candidates = withRegisterSources(numericGroups.flatMap(g => g.registers), groups, device)
  const pointLabels = buildPointLabels(candidates, groups, t, device.mode === 'slave' ? device.slaveId : undefined)
  const [selection, setSelection] = useState<Set<number> | null>(null)
  const chosen = candidates.filter(r => selection === null || selection.has(r.id)).slice(0, selection === null ? 4 : 8)
  const selected = new Set(chosen.map(r => r.id))
  const [seconds, setSeconds] = useState(60)
  const [frame, setFrame] = useState<{ buffer: CurveBuffer; now: number }>({ buffer: {}, now: Date.now() })
  const [frozen, setFrozen] = useState<typeof frame | null>(null)
  const buffer = useRef<CurveBuffer>({})
  const inputs = useRef({ chosen, latest, device, groups, groupErrors, threshold, active, frozen })
  inputs.current = { chosen, latest, device, groups, groupErrors, threshold, active, frozen }
  useEffect(() => {
    const timer = setInterval(() => {
      const input = inputs.current
      const blocked = new Set(input.groups.filter(g => !input.device.isActive || !g.isActive || input.groupErrors[g.id]).flatMap(g => g.registers.map(r => r.id)))
      const now = Date.now()
      buffer.current = sampleCurve(buffer.current, input.chosen, input.latest, input.device.id, now, input.threshold, blocked)
      if (input.active && !input.frozen && document.visibilityState !== 'hidden') setFrame({ buffer: buffer.current, now })
    }, 250)
    return () => clearInterval(timer)
  }, [])
  const visible = frozen ?? frame
  const visibleBuffer = Object.fromEntries(chosen.map(r => [r.id, curveTrackFor(visible.buffer, r, device.id)]))
  const displayTracks = Object.fromEntries(chosen.map(r => [r.id, curveDisplayPoints(visibleBuffer[r.id]?.points ?? [])]))
  const timeReordered = chosen.some(r => displayTracks[r.id].reordered)
  const sourceChanged = chosen.some(r => visible.buffer[r.id] && !visibleBuffer[r.id])
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
  const mixedUnits = valueMode === 'physical' && new Set(chosen.map(r => r.unit?.trim() || '')).size > 1
  const series = chosen.map(r => ({ r, color: CHART_COLORS[Math.abs(r.id) % CHART_COLORS.length], points: displayTracks[r.id].points.filter(p => p[0] >= startTime && p[0] <= endTime).map(([time, value]): [number, number | null] => [time, curveValue(value, r, valueMode)]) }))
  let low = Infinity, high = -Infinity
  for (const s of series) for (const [, v] of s.points) if (v !== null) { low = Math.min(low, v); high = Math.max(high, v) }
  const hasData = Number.isFinite(low) && Number.isFinite(high)
  if (!hasData) { low = 0; high = 1 }
  const pad = low === high ? Math.max(1, Math.abs(low) * .05) : (high - low) * .08
  low -= pad; high += pad
  const left = 70, top = 16, bottom = 58, right = 16
  const plotWidth = Math.max(1, size.w - left - right), plotHeight = Math.max(1, size.h - top - bottom)
  const x = (time: number) => left + (time - startTime) / (endTime - startTime) * plotWidth
  const y = (value: number) => top + (high - value) / (high - low) * plotHeight
  const scaleValid = Number.isFinite(low) && Number.isFinite(high) && Number.isFinite(high - low) && high > low
  const pathFor = (points: Array<[number, number | null]>) => {
    let path = '', previous: number | null = null
    for (const [time, value] of points) {
      if (value === null) { previous = null; continue }
      path += `${previous === null || time - previous > threshold ? 'M' : 'L'}${x(time).toFixed(2)},${y(value).toFixed(2)} `
      previous = time
    }
    return path
  }
  const cursorTime = hover
  const markerPathFor = (points: Array<[number, number | null]>) => isolatedCurvePoints(points, threshold).map(([time, value]) => `M${(x(time) - 3).toFixed(2)},${y(value).toFixed(2)}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0Z`).join(' ')
  const liveReadings = series.map(s => {
    const at = cursorTime ?? endTime
    let sample: [number, number | null] | undefined
    for (const p of displayTracks[s.r.id]?.points ?? []) if (p[0] <= at) sample = p
    const value = sample && at - sample[0] <= threshold ? curveValue(sample[1], s.r, valueMode) : null
    return { id: s.r.id, label: pointLabels.get(s.r.id)!, color: s.color, value: value === null ? '—' : displayNumber(value, valueMode === 'physical' ? s.r : undefined) + (valueMode === 'physical' && s.r.unit ? ' ' + s.r.unit : ''), time: value !== null && sample ? sample[0] : null, point: sample && value !== null ? [sample[0], value] as [number, number] : null }
  })
  const clear = () => {
    buffer.current = Object.fromEntries(Object.entries(buffer.current).map(([id, track]) => [id, { ...track, points: [] }]))
    setFrame({ buffer: buffer.current, now: Date.now() }); setFrozen(null); setHover(null)
  }
  return <div className={"live-curve-view" + (expanded ? " expanded" : "")}>
    <div className="toolbar">
      <button className="btn" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '退出铺满' : '铺满窗口'}</button>
      <ValueModeControl t={t} value={valueMode} onChange={mode => { setValueMode(mode); setHover(null) }} />
      <RegisterSelectButton t={t} groups={numericGroups} deviceSlaveId={device.mode === 'slave' ? device.slaveId : undefined} selected={selected} max={8} onApply={ids => { setSelection(ids); setFrozen(null); setHover(null) }} />
      <label className="live-window-label">{t('liveWindow')}<select className="hist-input" value={seconds} onChange={e => { setSeconds(Number(e.target.value)); setHover(null) }}>{[30, 60, 300, 600].map(n => <option key={n} value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>)}</select></label>
      <button className="btn" onClick={() => { setFrozen(frozen ? null : frame); setHover(null) }}>{t(frozen ? 'resumeCurve' : 'freezeCurve')}</button>
      <button className="btn" onClick={clear}>{t('clearCurve')}</button>
      <span className={'status-badge' + (!frozen ? ' on' : '')}>{t(frozen ? 'curvePaused' : 'curveTracking')}</span>
    </div>
    <p className="chart-hint">{t('liveCurveHint')}</p>
    {sourceChanged && <p className="chart-hint" role="status">{t('curveSourceChanged')}</p>}
    {timeReordered && <p className="chart-hint" role="status">{t('curveTimeReordered')}</p>}
    <div className="chart-wrap">
      <ChartReadout t={t} time={cursorTime} rows={liveReadings} />
      <div className="live-curve-plot" ref={setPlot}>
        {scaleValid ? <svg width="100%" height="100%" role="img" aria-label={t('liveCurve')}
          style={{ touchAction: 'pan-y' }}
          onPointerDown={e => { if (e.pointerType !== 'mouse') e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); setHover(startTime + Math.max(0, Math.min(1, (e.clientX - rect.left - left) / plotWidth)) * (endTime - startTime)) }}
          onPointerMove={e => { const rect = e.currentTarget.getBoundingClientRect(); setHover(startTime + Math.max(0, Math.min(1, (e.clientX - rect.left - left) / plotWidth)) * (endTime - startTime)) }}>
          {yTicks(low, high, 5).map(v => <g key={v}><line x1={left} x2={size.w - right} y1={y(v)} y2={y(v)} stroke="var(--border-1)" /><text x={left - 9} y={y(v) + 4} textAnchor="end" fill="var(--text-3)" fontSize={11}>{tickNum(v)}</text></g>)}
          {timeTicks(startTime, endTime, Math.max(2, Math.floor(plotWidth / 110))).map(time => <text key={time} x={x(time)} y={size.h - bottom + 20} textAnchor="middle" fill="var(--text-3)" fontSize={11}>{tickTime(time, endTime - startTime)}</text>)}
          {series.map(s => <g key={s.r.id}><path data-live-series={s.r.id} d={pathFor(s.points)} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" /><path data-live-markers={s.r.id} d={markerPathFor(s.points)} fill={s.color} /></g>)}
          {cursorTime !== null && cursorTime >= startTime && cursorTime <= endTime && <>
            <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={size.h - bottom} stroke="var(--text-3)" strokeDasharray="4 4" />
            {liveReadings.filter(r => r.point && r.point[0] >= startTime && r.point[0] <= endTime).map(r => <circle key={r.id} cx={x(r.point![0])} cy={y(r.point![1])} r={3.5} fill={r.color} stroke="var(--surface)" strokeWidth={1.5} />)}
            <ChartCursorTime time={cursorTime} x={x(cursorTime)} width={size.w} y={size.h - 24} />
          </>}
        </svg> : <div className="hist-empty warn" role="status">{t('curveScaleUnavailable')}</div>}
        {scaleValid && (!hasData || chosen.length === 0) && <div className="live-curve-empty">{t(candidates.length === 0 ? 'curveNoNumeric' : chosen.length === 0 ? 'histNoRegs' : 'curveWaiting')}</div>}
      </div>

    </div>
    <p className="chart-hint live-curve-footnote">{t(valueMode === 'physical' ? 'livePhysicalHint' : 'liveRawHint')}{mixedUnits && ' ' + t('mixedUnitsHint')}</p>
  </div>
})

function chartCursorLabel(time: number, short = false) {
  const date = new Date(time)
  const text = formatLocalTs(date.toISOString())
  return (short ? text.slice(-8) : text) + '.' + String(date.getMilliseconds()).padStart(3, '0')
}

function ChartCursorTime({ time, x, width, y }: { time: number; x: number; width: number; y: number }) {
  const labelWidth = Math.min(width - 8, width < 500 ? 112 : 192)
  const left = Math.max(4, Math.min(width - labelWidth - 4, x - labelWidth / 2))
  return <g className="chart-cursor-time" pointerEvents="none" data-cursor-time={time}>
    <rect x={left} y={y} width={labelWidth} height={22} rx={5} fill="var(--text-1)" />
    <text x={left + labelWidth / 2} y={y + 15} textAnchor="middle" fill="var(--bg)" fontSize={11}>{chartCursorLabel(time, width < 500)}</text>
  </g>
}

function ChartReadout({ t, time, rows }: { t: T; time: number | null; rows: { id: number; label: PointLabelData; color: string; value: string; time: number | null }[] }) {
  return <div className="chart-readout" role="group" aria-label={t('histNearest')}>
    <div className="chart-readout-heading"><span>{time === null ? t('lastSample') : t('curveTime')}</span>{time !== null && <time>{chartCursorLabel(time)}</time>}</div>
    <div className="chart-readout-items">{rows.map(row => <div className="chart-readout-item" key={row.id}>
      <i style={{ background: row.color }} /><span className="chart-readout-name"><PointLabel label={row.label} /></span><strong title={row.value}>{row.value}</strong>
      <time>{row.time === null ? t('histEmpty') : formatLocalTs(new Date(row.time).toISOString())}</time>
    </div>)}</div>
  </div>
}

function ChartBody({ queryContextKey, pointLabels, valueMode, t, registers, selected, pts, sourceSeries, status, error, range, onViewportChange }: {
  valueMode: ValueMode; t: T; registers: Register[]; selected: Set<number>; pts: HistoryPoint[]; status: 'idle' | 'loading' | 'done' | 'error'; error: string | null
  pointLabels: Map<number, PointLabelData>; sourceSeries?: HistorySeries[]; range: { start: number; end: number }; onViewportChange: (view: { start: number; end: number } | null) => void
  queryContextKey: string
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
  const series = useMemo(() => (sourceSeries ?? decodeHistorySeries(registers, pts, selected)).filter(s => selected.has(s.id)).map(s => { const r = registers.find(r => r.id === s.id)!; return { ...s, samples: s.samples.map(([time, value]): [number, number | null] => [time, curveValue(value, r, valueMode)]) } }), [registers, pts, sourceSeries, selected, valueMode])
  const comparisonContext = useMemo(() => JSON.stringify([queryContextKey, historyComparisonContext(registers.filter(r => selected.has(r.id)), range, valueMode, hidden)]), [queryContextKey, registers, selected, range.start, range.end, valueMode, hidden])
  const [comparison, setComparison] = useState<HistoryComparisonState>(() => ({ context: comparisonContext, a: null, b: null }))
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const activeComparison = comparison.context === comparisonContext ? comparison : { context: comparisonContext, a: null, b: null }
  useEffect(() => { setComparison(previous => updateHistoryComparison(previous, { type: 'context', context: comparisonContext })) }, [comparisonContext])
  const mixedUnits = valueMode === 'physical' && new Set(registers.filter(r => selected.has(r.id)).map(r => r.unit?.trim() || '')).size > 1
  const reading = (value: number, reg?: Register) => displayNumber(value, valueMode === 'physical' ? reg : undefined) + (valueMode === 'physical' && reg?.unit ? ' ' + reg.unit : '')
  useEffect(() => { setYView(null); setHover(null); setDrag(null); dragRef.current = null }, [valueMode, queryContextKey])
  useEffect(() => { setView(null); setYView(null); setHover(null); setDrag(null); dragRef.current = null }, [range.start, range.end])
  const setPlot = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!el) return
    const measure = () => { if (el.clientWidth) setSize({ w: el.clientWidth, h: el.clientHeight }) }
    measure(); observer.current = new ResizeObserver(measure); observer.current.observe(el)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  const start = view?.start ?? range.start, end = view?.end ?? range.end
  const span = Math.max(1, end - start)
  const L = 72, R = 18, T = 16, B = 58
  const pw = Math.max(1, size.w - L - R), ph = Math.max(1, size.h - T - B)
  const x = (time: number) => L + (time - start) / span * pw
  const visibleSeries = series.map(s => {
    const samples = s.samples.filter(p => p[0] >= start && p[0] <= end)
    const { min, max, last } = historySampleStats(samples)
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
  const scaleValid = Number.isFinite(yMin) && Number.isFinite(yMax) && Number.isFinite(ySpan) && ySpan > 0 && visibleSeries.filter(s => !hidden.has(s.id)).every(s => !Number.isFinite(s.min) || [s.min, s.max].every(value => Number.isFinite(y(displayValue(value, s)))))
  const pathFor = (s: typeof visibleSeries[number]) => {
    let path = ''
    const starts = historyLineStarts(s.samples, s.gapMs, s.segments)
    for (const [index, [time, value]] of s.samples.entries()) {
      if (value === null || !Number.isFinite(value)) continue
      path += `${starts.has(index) ? 'M' : 'L'}${x(time).toFixed(2)},${y(displayValue(value, s)).toFixed(2)} `
    }
    return path
  }
  const markerPathFor = (s: typeof visibleSeries[number]) => isolatedHistoryPoints(s.samples, s.gapMs, s.segments).map(([time, value]) => `M${(x(time) - 3).toFixed(2)},${y(displayValue(value, s)).toFixed(2)}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0Z`).join(' ')
  const focusRange = (center: number, width: number) => {
    const clampedWidth = Math.min(range.end - range.start, Math.max(1000, width))
    const left = Math.max(range.start, Math.min(range.end - clampedWidth, center - clampedWidth / 2))
    const next = historyQueryRange({ start: left, end: left + clampedWidth })
    setView(next); onViewportChange(next); setHover(null)
  }
  const pointerTime = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return start + Math.max(0, Math.min(1, (e.clientX - rect.left - L) / pw)) * span
  }
  const pointerValue = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return yMax - Math.max(0, Math.min(1, (e.clientY - rect.top - T) / ph)) * ySpan
  }
  const readoutRows = visibleSeries.filter(s => !hidden.has(s.id)).map(s => {
    const reg = registers.find(r => r.id === s.id)
    const point = hover === null ? s.samples.at(-1) ?? null : nearestHistorySample(s.samples, hover)
    const valid = point != null && (hover === null || Math.abs(point[0] - hover) <= s.gapMs / 2) && point[1] !== null
    return { id: s.id, label: pointLabels.get(s.id)!, color: s.color, value: (valid ? reading(point![1]!, reg) : '—') + ' [' + historyVerificationLabel[point ? s.verification?.find(v => v[0] === point[0])?.[1] ?? 'unverified' : 'unknown'] + ']', time: valid ? point![0] : null, point: valid ? point as [number, number] : null }
  })
  if (selected.size === 0) return <div className="hist-empty">{t('histNoRegs')}</div>
  if (status === 'idle') return <div className="hist-empty" role="status">{t('histCancelled')}</div>
  if (status === 'loading') return <div className="hist-empty" role="status">{t('histLoading')}</div>
  if (status === 'error') return <div className="hist-empty warn" role="alert">{t('histError')}: {error}</div>
  const hasSamples = pts.length > 0 || series.some(s => s.samples.length)
  if (!hasSamples && !view && !activeComparison.a && !activeComparison.b) return <div className="hist-empty">{t('histEmpty')}</div>
  if (!series.length && hasSamples) return <div className="hist-empty">{t('histNoNumeric')}</div>
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
      <button className="btn" onClick={() => { setView(null); onViewportChange(null); setYView(null); setHover(null) }} disabled={!view && !yView}>{t('curveReset')}</button>
      <label className="issues-filter"><input type="checkbox" checked={relative} onChange={e => { setRelative(e.target.checked); setYView(null) }} />{t('histRelative')}</label>
    </div>
    <p className="chart-hint">悬停查看读数 · 横向拖动放大时间，纵向拖动放大 Y 轴，斜向框选同时放大两轴 · 双击恢复全范围</p>
    <div className="history-chart-range">{formatLocalTs(new Date(start).toISOString())} — {formatLocalTs(new Date(end).toISOString())}</div>
    <ChartReadout t={t} time={hover} rows={readoutRows} />
    <HistoryComparison open={comparisonOpen} onOpenChange={setComparisonOpen} state={activeComparison} canCapture={hover !== null && visibleSeries.some(s => !hidden.has(s.id))} t={t} pointLabels={pointLabels} formatTime={chartCursorLabel}
      formatValue={(id, value) => reading(value, registers.find(r => r.id === id))}
      onCapture={slot => { if (hover !== null) setComparison(previous => updateHistoryComparison(previous, { type: 'capture', context: comparisonContext, slot, anchor: captureHistoryAnchor(hover, visibleSeries.filter(s => !hidden.has(s.id))) })) }}
      onClear={() => setComparison(previous => updateHistoryComparison(previous, { type: 'clear', context: comparisonContext }))} />
    <div className="history-chart-plot" ref={setPlot}>
      {scaleValid ? <svg width="100%" height="100%" role="img" aria-label={t('tabCurve')} style={{ touchAction: 'none' }}
        onPointerDown={e => { if (e.button !== 0) return; if (e.pointerType === 'touch') { setHover(pointerTime(e)); e.currentTarget.setPointerCapture(e.pointerId); return }; const time = pointerTime(e), value = pointerValue(e); dragRef.current = { start: time, end: time, fromY: value, toY: value }; setDrag(dragRef.current); setHover(null); e.currentTarget.setPointerCapture(e.pointerId) }}
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
        onDoubleClick={() => { setView(null); onViewportChange(null); setYView(null); setHover(null) }}>
        <defs><clipPath id={clipId}><rect x={L} y={T} width={pw} height={ph} /></clipPath></defs>
        {yTicks(yMin, yMax, 5).map(value => <g key={value}><line x1={L} x2={size.w - R} y1={y(value)} y2={y(value)} stroke="var(--border-1)" /><text x={L - 8} y={y(value) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">{tickNum(value)}{relative ? '%' : ''}</text></g>)}
        {timeTicks(start, end, Math.max(2, Math.floor(pw / 110))).map(time => <text key={time} x={x(time)} y={size.h - B + 20} textAnchor="middle" fontSize={11} fill="var(--text-3)">{tickTime(time, span)}</text>)}
        <g clipPath={`url(#${clipId})`}>
          {([['A', activeComparison.a], ['B', activeComparison.b]] as const).map(([label, anchor], index) => anchor && anchor.time >= start && anchor.time <= end && <g key={label} className="history-comparison-marker" data-comparison-anchor={label}>
            <line x1={x(anchor.time)} x2={x(anchor.time)} y1={T} y2={size.h - B} stroke={index ? '#a78bfa' : '#22d3ee'} strokeDasharray="6 4" />
            <text x={x(anchor.time) + 4} y={T + 12 + index * 15} fill={index ? '#a78bfa' : '#22d3ee'} fontSize={12}>{label}</text>
          </g>)}
          {visibleSeries.filter(s => !hidden.has(s.id)).map(s => <g key={s.id}><path data-history-series={s.id} d={pathFor(s)} stroke={s.color} fill="none" strokeWidth={1.8} /><path data-history-markers={s.id} d={markerPathFor(s)} fill={s.color} /></g>)}
          {hover !== null && !drag && <>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={size.h - B} stroke="var(--text-3)" strokeDasharray="4 4" />
            {readoutRows.filter(r => r.point).map(r => { const s = visibleSeries.find(s => s.id === r.id)!; return <circle key={r.id} cx={x(r.point![0])} cy={y(displayValue(r.point![1], s))} r={3.5} fill={r.color} stroke="var(--surface)" strokeWidth={1.5} /> })}
          </>}
          {drag && <rect className="zoom-box" x={Math.abs(x(drag.end) - x(drag.start)) > 8 ? x(Math.min(drag.start, drag.end)) : L} y={Math.abs(y(drag.toY) - y(drag.fromY)) > 8 ? y(Math.max(drag.fromY, drag.toY)) : T} width={Math.abs(x(drag.end) - x(drag.start)) > 8 ? Math.abs(x(drag.end) - x(drag.start)) : pw} height={Math.abs(y(drag.toY) - y(drag.fromY)) > 8 ? Math.abs(y(drag.toY) - y(drag.fromY)) : ph} />}
        </g>
        {hover !== null && !drag && <ChartCursorTime time={hover} x={x(hover)} width={size.w} y={size.h - 24} />}
      </svg> : <div className="hist-empty warn" role="status">{t('curveScaleUnavailable')}</div>}
      {scaleValid && !anyVisible && <div className="live-curve-empty">{t(hasSamples ? 'histNoVisible' : 'histEmpty')}</div>}
    </div>
    <div className="history-legend-head"><span>{t('histLegendHint')}</span><span>{t('histStatsHint')}</span></div>
    <div className="history-legend">
      {visibleSeries.map(s => { const reg = registers.find(r => r.id === s.id); return <button key={s.id} className={'history-series-toggle' + (hidden.has(s.id) ? ' muted' : '')} aria-pressed={!hidden.has(s.id)} onClick={() => setHidden(old => { const next = new Set(old); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next })}>
        <span className="legend-swatch" style={{ background: s.color }} /><strong><PointLabel label={pointLabels.get(s.id)!} />{!pointLabels.get(s.id)!.qualified && <small> ({reg?.startAddress})</small>}</strong>
        <span>Min <b>{Number.isFinite(s.min) ? reading(s.min, reg) : '—'}</b></span><span>Max <b>{Number.isFinite(s.max) ? reading(s.max, reg) : '—'}</b></span><span>{t('histLastValue')} <b>{s.last === null ? '—' : reading(s.last, reg)}</b></span>
      </button> })}
    </div>
    <p className="chart-hint history-sampling-note">{t('histSamplingNote')}{relative && ' ' + t('histRelativeNote')}{mixedUnits && !relative && ' ' + t('mixedUnitsHint')}</p>
  </div>
}

function RawDataView({ t, device }: { t: T; device: Device | null }) {
  const [clearedToken, setClearedToken] = useState('')
  const [limit, setLimit] = useState(200)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const reader = useMemo(() => new RawFramesRead(device, limit), [device?.id, device?.transport, device?.serialPath, device?.ip, device?.port, device?.baudRate, device?.parity, device?.stopBits, device?.dataBits, device?.flowControl, device?.slaveId, limit])
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const frames = state.value?.frames ?? [], busy = state.phase === 'loading', readerRef = useRef(reader), mounted = useRef(false)
  readerRef.current = reader
  const load = useCallback(() => pausedRef.current ? Promise.resolve() : reader.refresh(fetchRawFrames), [reader])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; reader.cancel() }
  }, [reader])
  useEffect(() => {
    if (paused) { reader.cancel(); return }
    void load()
    const id = setInterval(() => { void load() }, 1000)
    return () => { clearInterval(id); reader.cancel() }
  }, [load, paused, reader])
  const togglePause = () => {
    pausedRef.current = !pausedRef.current
    reader.cancel()
    setPaused(pausedRef.current)
  }
  const dir = (d: string) => d === 'tx' ? 'TX' : 'RX'
  if (!device) return <div className="db-view"><div className="hist-empty">{t('emptyHint')}</div></div>
  return (
    <div>
      <div className="db-head"><div><div className="db-title">{t('tabRaw')}</div><div className="kv">{device.name} · {device.transport === 'rtu' ? device.serialPath : device.ip + ':' + device.port}</div></div></div>
      <CommunicationSummary key={clearedToken} device={device} english={t('cancel') === 'Cancel'} />
      <div className="toolbar">
        <span className="kv" role="status">{paused ? '已暂停刷新 · 设备采集继续' : '串口/TCP 原始报文（自动刷新 1s）'}</span>
        <label className="kv">显示帧数
          <input type="number" min={1} max={2000} value={limit}
            style={{ width: 70, marginLeft: 6 }}
            onChange={(e) => setLimit(clampFrameLimit(Number(e.target.value)))}
            onBlur={(e) => setLimit(clampFrameLimit(Number(e.target.value)))} />
        </label>
        <div style={{ flex: 1 }} />
        <button className={'btn' + (paused ? ' selected' : '')} aria-pressed={paused} onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button className="btn" onClick={() => void load()} disabled={busy || paused}>{busy ? '…' : '刷新'}</button>
        <DiagnosticsCleanupButton device={device} disabled={paused} english={t('cancel') === 'Cancel'} onCleared={result => { setClearedToken(result.token); if (mounted.current && readerRef.current === reader) { reader.invalidate(); void load() } }} />
      </div>
      <RawFramesStatus state={state} paused={paused} english={t('cancel') === 'Cancel'} />
      <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, maxHeight: '60vh', overflow: 'auto', background: 'var(--surface)', color: 'var(--text-1, #eee)', borderRadius: 6, padding: 8 }}>
        {frames.length === 0 ? null : (
          frames.map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 10, padding: '1px 0', borderBottom: '1px solid var(--border-1, #222)' }}>
              <span style={{ color: 'var(--text-3, #888)', minWidth: 72 }}>{formatLocalTs(f.timestamp).slice(11)}</span>
              <span style={{ color: f.direction === 'tx' ? 'var(--accent)' : 'var(--success)', minWidth: 28, fontWeight: 600 }}>{dir(f.direction)}</span>
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
  const [statusError, setStatusError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => { try { setFirmwares(await api.get('/api/firmwares')) } catch (e: any) { setMsg(t('loadFailed') + ': ' + (e?.message ?? '')) } }, [t])
  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let alive = true
    const poll = async () => { try { const s = await api.get('/api/ota/status?device_id=' + device.id); if (alive) { setStatus(s); setStatusError('') } } catch (e: any) { if (alive) setStatusError(e?.message ?? String(e)) } }
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
    try { await api.post('/api/ota/upgrade', { device_id: device.id, firmware_id: fid }); setStatus({ state: 'starting', percent: 0 }); setMsg(t('fwStarted')) }
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

  const state = status.state ?? 'idle'
  const active = ['starting', 'transferring', 'verifying'].includes(state)
  const pct = Math.max(0, Math.min(100, Number(status.percent) || 0))
  const chinese = t('tabFirmware') === '固件'
  const label = (zh: string, en: string) => chinese ? zh : en
  const stateNames: Record<string, string> = {
    idle: label('等待升级', 'Ready'), starting: label('正在准备', 'Preparing'),
    transferring: label('正在传输', 'Transferring'), verifying: label('正在校验', 'Verifying'),
    done: label('升级完成', 'Completed'), failed: label('升级失败', 'Failed'), aborted: label('已中止', 'Aborted'),
  }
  const abort = async () => {
    setBusy(true)
    try { await api.post('/api/ota/abort', { device_id: device.id }); setStatus(await api.get('/api/ota/status?device_id=' + device.id)) }
    catch (e: any) { setMsg(t('operationFailed') + ': ' + (e?.message ?? '')) }
    finally { setBusy(false) }
  }
  return (
    <div className="firmware-dashboard">
      <section className="chart-wrap firmware-status-card">
        <div className="fw-section-head">
          <div><div className="section-eyebrow">{label('目标设备', 'Target device')}</div><h3>{device.name}</h3><p className="kv">{device.transport.toUpperCase()} · {device.transport === 'rtu' ? device.serialPath : device.ip + ':' + device.port}</p></div>
          <span className={'status-badge' + (state === 'done' ? ' on' : '')} role="status">{stateNames[state] || state}</span>
        </div>
        <div className="fw-progress-summary"><strong>{pct}<small>%</small></strong><span className="kv">{state === 'idle' ? label('从下方选择固件开始升级', 'Choose firmware below to begin') : `${status.currentBlock ?? 0} / ${status.totalBlocks ?? 0} ${label('数据块', 'blocks')}`}</span>
          {active && <button className="btn danger" disabled={busy} onClick={() => void abort()}>{t('fwAbort')}</button>}
        </div>
        <div className="fw-bar" role="progressbar" aria-label={t('fwState')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div style={{ width: pct + '%' }} /></div>
        <div className="fw-stages">{['starting', 'transferring', 'verifying', 'done'].map((step, i) => <span key={step} className={state === step ? 'current' : ''}><b>{i + 1}</b>{[label('准备', 'Prepare'), label('传输', 'Transfer'), label('校验', 'Verify'), label('完成', 'Complete')][i]}</span>)}</div>
        {status.error && <div className="fw-err" role="alert">{status.error}</div>}
        {statusError && <div className="fw-err" role="alert">{label('升级状态暂时无法更新：', 'Status update unavailable: ')}{statusError}</div>}
      </section>
      <section className="chart-wrap firmware-library">
        <div className="fw-section-head"><div><h3>{label('固件库', 'Firmware library')} <span className="fw-count">{firmwares.length}</span></h3><p className="kv">{label('上传文件后，可选择固件升级当前设备', 'Upload a file, then upgrade the current device')}</p></div>
          <input ref={fileInput} type="file" hidden onChange={onFile} disabled={busy || active} />
          <button className="btn primary" disabled={busy || active} onClick={() => fileInput.current?.click()}>＋ {t('fwUpload')}</button>
        </div>
        {msg && <div className="fw-feedback" role="status">{msg}</div>}
        <div className="fw-list">
          {firmwares.length === 0 && <div className="fw-empty"><span aria-hidden="true">⇧</span><strong>{t('firmwareHint')}</strong><p>{label('点击右上方“上传固件”添加第一个文件', 'Use Upload firmware to add your first file')}</p></div>}
          {firmwares.map(f => <div key={f.id} className="fw-item">
            <div className="fw-file-icon" aria-hidden="true">BIN</div>
            <div className="fw-file-info"><div className="fw-name" title={f.name}>{f.name}</div><div className="fw-file-meta"><span>{fmtBytes(f.size)}</span><span>{label('版本', 'Version')} {f.version || '—'}</span><code>CRC32 {(f.crc32 >>> 0).toString(16).padStart(8, '0').toUpperCase()}</code></div></div>
            <div className="fw-file-actions"><button className="btn" disabled={busy || active || !!statusError} onClick={() => void upgrade(f.id)}>{t('fwUpgrade')}</button><button className="btn danger" disabled={busy || active} aria-label={t('fwDelete') + ' ' + f.name} onClick={() => void remove(f.id, f.name)}>{t('fwDelete')}</button></div>
          </div>)}
        </div>
      </section>
    </div>
  )
}
