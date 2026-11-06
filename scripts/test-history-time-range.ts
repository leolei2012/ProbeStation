import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { historyTimeRange, resolveHistoryTimeRange, editHistoryTime, changeHistoryInputZone, historyPresetRange, historyTimeOffset, historyTimeText, formatHistoryTime } from '../apps/web/src/history-time-range.ts'
import { HistoryTimeRange } from '../apps/web/src/HistoryTimeRange.tsx'
import { HistoryNavigation } from '../apps/web/src/history-navigation.ts'
import { historyQueryPlan } from '../apps/web/src/history-query-task.ts'
import { captureHistoryExport } from '../apps/web/src/history-export.ts'

const previousTestZone = process.env.TZ
const legacyText = (instant: number) => { const d = new Date(instant), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` }
try {
  process.env.TZ = 'UTC'
  const start = Date.parse('2026-11-06T00:00:00.123Z'), end = Date.parse('2026-11-06T00:00:00.987Z')
  const navigation = new HistoryNavigation().consume({ deviceId: 1, view: 'history', start: new Date(start).toISOString(), end: new Date(end).toISOString(), registerId: 11 }, 1, [11], true)!
  assert.equal(Date.parse(legacyText(navigation.range!.start)), Date.parse(legacyText(navigation.range!.end)), 'old UI collapses a valid subsecond reference into equal endpoints')
  const range = historyTimeRange(navigation.range!.start, navigation.range!.end)
  assert.equal(range.start.text, '2026-11-06T00:00:00.123'); assert.equal(range.end.text, '2026-11-06T00:00:00.987')
  assert.deepEqual(resolveHistoryTimeRange(range), { start, end, fieldsValid: true, valid: true })
  assert.equal(resolveHistoryTimeRange(historyTimeRange(end - 1, end)).valid, true, 'one millisecond remains a valid positive interval')
  assert.ok(Object.isFrozen(range)); assert.ok(Object.isFrozen(range.start))
  const plan = historyQueryPlan({ objectId: 1, start, end, mode: 'chart', page: 0, registerIds: [11] })
  const params = new URL(plan.url, 'http://example.invalid').searchParams
  assert.equal(params.get('start'), '2026-11-06T00:00:00.123Z'); assert.equal(params.get('end'), '2026-11-06T00:00:00.987Z')
  const switched = changeHistoryInputZone(range, 'utc'), resolved = resolveHistoryTimeRange(switched)
  assert.equal(historyQueryPlan({ objectId: 1, start: resolved.start, end: resolved.end, mode: 'chart', page: 0, registerIds: [11] }).url, plan.url, 'zone-only changes cannot alter the query identity')
  assert.equal(captureHistoryExport(1, resolved, [11], 0, 'full').end, '2026-11-06T00:00:00.987Z', 'the exact endpoint survives export capture')
  const edited = editHistoryTime(range, 'start', '2026-11-06T00:00:00.456')
  assert.equal(resolveHistoryTimeRange(edited).start, start + 333); assert.equal(edited.end, range.end, 'editing one field keeps the other absolute endpoint intact')
  for (const text of ['', 'not a date', '2026-02-29T10:00', '2026-02-31T10:00', '2026-01-01T24:00', '2026-01-01T00:60', '2026-01-01T00:00:60', '2026-01-01T00:00:00.1234', '0000-01-01T00:00']) {
    const invalid = editHistoryTime(switched, 'start', text)
    assert.equal(resolveHistoryTimeRange(invalid).valid, false, text)
    assert.equal(changeHistoryInputZone(invalid, 'local'), invalid, 'invalid drafts are never reinterpreted in another zone')
  }
  const leap = editHistoryTime(switched, 'start', '2024-02-29T23:59:59.001')
  assert.equal(resolveHistoryTimeRange(leap).start, Date.parse('2024-02-29T23:59:59.001Z'))
  assert.equal(resolveHistoryTimeRange(historyTimeRange(end, start)).valid, false)
  assert.equal(resolveHistoryTimeRange(historyTimeRange(start, start)).valid, false)
  assert.equal(resolveHistoryTimeRange(historyTimeRange(NaN, Infinity)).fieldsValid, false)
  const yearOne = historyTimeRange(Date.parse('0001-01-01T00:00:00.001Z'), Date.parse('0099-01-01T00:00:00.002Z'), 'utc')
  assert.equal(resolveHistoryTimeRange(yearOne).start, Date.parse('0001-01-01T00:00:00.001Z'), 'years below 100 do not become 1900-based')
  assert.equal(formatHistoryTime(NaN, 'utc'), '')
  assert.equal(historyTimeOffset(NaN, 'local'), '—')

  process.env.TZ = 'America/New_York'
  const first = Date.parse('2026-11-01T05:30:00.000Z'), second = Date.parse('2026-11-01T06:30:00.000Z')
  assert.equal(formatHistoryTime(first, 'local'), formatHistoryTime(second, 'local'))
  assert.equal(Date.parse(legacyText(second) + '.000'), first, 'even adding milliseconds to the old formatter loses the second DST occurrence')
  const repeated = historyTimeRange(first, second), exactSecond = historyTimeRange(second, second + 60_987)
  assert.deepEqual(resolveHistoryTimeRange(repeated), { start: first, end: second, fieldsValid: true, valid: true }, 'identical local wall times may be a valid nonzero absolute interval')
  assert.equal(historyTimeOffset(first, 'local'), 'UTC-04:00'); assert.equal(historyTimeOffset(second, 'local'), 'UTC-05:00')
  assert.equal(editHistoryTime(exactSecond, 'start', '2026-11-01T01:30'), exactSecond, 'native omission of zero seconds/milliseconds must not discard absolute identity')
  const utc = changeHistoryInputZone(exactSecond, 'utc'), back = changeHistoryInputZone(utc, 'local')
  assert.equal(utc.start.text, '2026-11-01T06:30:00.000')
  assert.deepEqual(resolveHistoryTimeRange(back), resolveHistoryTimeRange(exactSecond))
  const manual = editHistoryTime(exactSecond, 'end', '2026-11-01T01:50:00.000')
  assert.equal(resolveHistoryTimeRange(manual).start, second)
  assert.equal(resolveHistoryTimeRange(manual).end, first + 20 * 60_000, 'manual ambiguous input retains existing browser resolution; imported endpoint remains absolute')
  assert.equal(resolveHistoryTimeRange(manual).valid, false)
  assert.equal(changeHistoryInputZone(manual, 'utc').zone, 'utc', 'an inverted but parseable interval can still be edited in UTC')
  const gap = editHistoryTime(exactSecond, 'start', '2026-03-08T02:30:00.000')
  assert.equal(resolveHistoryTimeRange(gap).fieldsValid, false, 'nonexistent spring-forward time must not silently become 03:30')
  const now = Date.parse('2026-11-01T07:30:00.987Z'), today = resolveHistoryTimeRange(historyPresetRange(0, now, 'utc'))
  assert.equal(today.start, Date.parse('2026-11-01T04:00:00.000Z')); assert.equal(today.end, now, 'Today remains the local calendar day even with UTC input')
  const lastHour = resolveHistoryTimeRange(historyPresetRange(60, now, 'local'))
  assert.equal(lastHour.end - lastHour.start, 3_600_000); assert.equal(lastHour.end, now)
  process.env.TZ = 'Asia/Kathmandu'
  assert.equal(resolveHistoryTimeRange(range).start, start, 'absolute endpoints remain authoritative if the host timezone changes')
  assert.equal(historyTimeText(range.start, range.zone), '2026-11-06T05:45:00.123')
  assert.equal(resolveHistoryTimeRange(edited).start, start + 333, 'valid manual input is also captured once as an absolute instant')
  assert.equal(historyTimeOffset(start, 'local'), 'UTC+05:45')
  assert.equal(historyTimeOffset(start, 'utc'), 'UTC+00:00')
  assert.equal(resolveHistoryTimeRange(changeHistoryInputZone(historyTimeRange(start, end), 'utc')).start, start)

  let actions = 0
  const render = (value = range, english = false) => renderToStaticMarkup(createElement(HistoryTimeRange, { range: value, english, onEdit() { actions++ }, onZone() { actions++ } }))
  assert.match(render(), /step="0\.001"/); assert.match(render(), /完整区间（UTC）/); assert.match(render(), /00:00:00\.987Z/)
  assert.match(render(historyTimeRange(second, second + 1000)), /UTC\+05:45/)
  process.env.TZ = 'America/New_York' // The gap is nonexistent in this zone, not in Kathmandu.
  assert.match(render(gap), /disabled=""/); assert.match(render(gap), /无效或不存在的时间/)
  assert.match(render(changeHistoryInputZone(historyTimeRange(start, end), 'utc'), true), /Time input zone/)
  assert.equal(actions, 0)
  console.log('HISTORY TIME RANGE OK: reference→input→query/export millisecond fidelity, subsecond ranges, DST duplicate instants/native normalization/roundtrip, gap/calendar rejection, per-field edits, offsets, UTC/local presets and SSR; Node TZ restored, no database/network/hardware')
} finally { if (previousTestZone === undefined) delete process.env.TZ; else process.env.TZ = previousTestZone }
