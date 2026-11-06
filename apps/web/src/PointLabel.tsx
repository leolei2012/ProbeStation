import React from 'react'
import { validSlaveId } from '../../../packages/core/src/sample-source'

export interface PointLabelData { name: string; detail: string; qualified: boolean }
export interface LabelPoint { id: number; groupId?: number; alias: string | null; startAddress: number; functionCode: number }
/** Current configuration identity only. This does not verify the source of a stored sample. */
export function buildPointLabels(points: readonly LabelPoint[], groups: readonly { id: number; slaveId?: number }[], t: (key: string) => string, deviceSlaveId?: number): Map<number, PointLabelData> {
  const names = points.map(p => p.alias?.trim() ? p.alias : '#' + p.startAddress)
  const counts = new Map<string, number>(), sources = new Map(groups.map(g => [g.id, g.slaveId]))
  for (const name of names) { const key = name.trim().toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1) }
  return new Map(points.map((point, i) => {
    const source = deviceSlaveId === undefined ? sources.get(point.groupId ?? -1) : deviceSlaveId
    const detail = `${validSlaveId(source) ? t('pointSource') + ' ' + source : t('pointSourceUnknown')} · FC${point.functionCode} · ${t('colAddr')} ${point.startAddress} · #${point.id}`
    return [point.id, { name: names[i], detail, qualified: counts.get(names[i].trim().toLowerCase())! > 1 }]
  }))
}
export function PointLabel({ label }: { label: PointLabelData }) {
  return <span className="point-label" title={label.name + ' · ' + label.detail}>
    <span className="point-label-name">{label.name}</span>
    {label.qualified && <small className="point-label-detail">{label.detail}</small>}
  </span>
}
