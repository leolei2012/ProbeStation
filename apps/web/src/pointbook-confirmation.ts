export interface PointBookOpening { readonly scope: symbol; readonly key: string; readonly deviceId: number }
/** A local page observation only, never a server revision or source authentication. */
export function capturePointBookOpening(scope: symbol | null, key: string | null, deviceId: number): PointBookOpening | null {
  return scope && key && Number.isSafeInteger(deviceId) && deviceId > 0 ? Object.freeze({ scope, key, deviceId }) : null
}
export function pointBookOpeningMatches(expected: PointBookOpening | null, current: PointBookOpening | null) {
  return !!expected && !!current && expected.scope === current.scope && expected.key === current.key && expected.deviceId === current.deviceId
}
export function pointBookReplacementPrompt(fileName: string, device: { id: number; name: string; transport: string; ip: string; port: number; serialPath: string | null }, groups: readonly { registers: readonly unknown[] }[], english: boolean) {
  const points = groups.reduce((count, group) => count + group.registers.length, 0), endpoint = device.transport === 'rtu' ? device.serialPath ?? '?' : device.ip + ':' + device.port
  return english
    ? `Replace the target device's ENTIRE point table?\nTarget: ${device.name} (#${device.id}), ${device.transport.toUpperCase()} ${endpoint}\nFile: ${fileName}\nThis replaces all target groups, points and their alarm rules; it is not append and is not limited to current filters. This page has loaded ${groups.length} groups / ${points} points; alarm rules are included but not counted here. These counts are not a deletion limit.\nThis is target/scope confirmation, not a file-content preview. Unsynchronized background edits or changes after confirmation may still be replaced. Check that nobody else is editing this device before continuing.`
    : `确认替换目标设备的全部点表？\n目标：${device.name}（#${device.id}），${device.transport.toUpperCase()} ${endpoint}\n文件：${fileName}\n会替换该设备全部分组、点位及其关联告警；不是追加，也不局限于当前筛选结果。本页已载入 ${groups.length} 个分组 / ${points} 个点位；关联告警也包含在内，但这里不统计条数。这些数量不是删除上限。\n这里只确认目标和范围，不是文件内容预览。后台未同步或确认后的修改仍可能被替换。请先确认无人同时编辑该设备，再决定是否继续。`
}
