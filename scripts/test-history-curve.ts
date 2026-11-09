import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as history from '../apps/web/src/history-curve.ts'
import { decodeHistorySeries, historySampleStats, historyLineStarts, historyQueryRange, nearestHistorySample, type HistoryPoint } from '../apps/web/src/history-curve.ts'

const t = Date.parse('2026-09-23T00:00:00Z')
// Request dates are serialized as ISO milliseconds. Completion must compare the same precision.
const fractional = historyQueryRange({ start: t + 145312.5, end: t + 154687.5 })
assert.equal(Date.parse(new Date(fractional.start).toISOString()), fractional.start, 'zoom start must match its completed request timestamp')
assert.equal(Date.parse(new Date(fractional.end).toISOString()), fractional.end, 'zoom end must match its completed request timestamp')
assert.deepEqual(historyQueryRange({ start: t, end: t + 1000 }), { start: t, end: t + 1000 })
let zoomRange = { start: t, end: t + 300000 }
for (let i = 0; i < 8; i++) {
  const width = Math.max(1000, (zoomRange.end - zoomRange.start) / 2), center = (zoomRange.start + zoomRange.end) / 2
  zoomRange = historyQueryRange({ start: center - width / 2, end: center + width / 2 })
  assert.equal(Date.parse(new Date(zoomRange.start).toISOString()), zoomRange.start, `repeat zoom ${i + 1} completes`)
  assert.equal(Date.parse(new Date(zoomRange.end).toISOString()), zoomRange.end)
}
for (const range of [{ start: t + 1234.567, end: t + 6789.123 }, { start: t + 500.25, end: t + 1500.75 }]) {
  const normalized = historyQueryRange(range)
  assert.deepEqual(historyQueryRange(normalized), normalized, 'drag/pan range normalization is stable')
  assert.ok(normalized.start < normalized.end)
  assert.ok(Math.abs(normalized.start - range.start) < 1 && Math.abs(normalized.end - range.end) < 1)
  assert.equal(Date.parse(new Date(normalized.start).toISOString()), normalized.start)
  assert.equal(Date.parse(new Date(normalized.end).toISOString()), normalized.end)
}
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 0], [36000, 0]])], [0], 'sparse retained points in one source segment stay connected')
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 1], [36000, 1]])], [0, 1], 'actual source gaps survive display downsampling')
assert.deepEqual([...historyLineStarts([[0, 1], [1000, null], [2000, 2]], 5400, [[0, 0], [1000, 1], [2000, 1]])], [0, 2], 'invalid readings still break the line')
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2]], 5400)], [0, 1], 'old server responses retain conservative fallback behavior')
assert.deepEqual([...historyLineStarts([[18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 1], [36000, 1]])], [0], 'viewport filtering preserves source segment identity')
assert.deepEqual(historySampleStats([[t, 2], [t + 1000, 10], [t + 2000, null]]), { min: 2, max: 10, last: null }, 'invalid final sample must not reuse the last valid reading')
assert.deepEqual(historySampleStats([[t, null]]), { min: Infinity, max: -Infinity, last: null })
assert.deepEqual(historySampleStats([]), { min: Infinity, max: -Infinity, last: null })
assert.deepEqual(historySampleStats([[t, 0]]), { min: 0, max: 0, last: 0 })
assert.equal(historySampleStats([[t, null], [t + 1000, -5]]).last, -5, 'a later valid sample recovers the last reading')
const r = { id: 1, groupId: 1, startAddress: 0, dataType: 'uint16', functionCode: 3 }
const p = (offset: number, address: number, rawValue: number, area = 'holding-register'): HistoryPoint => ({ ts: new Date(t + offset).toISOString(), area, address, rawValue })
const result = decodeHistorySeries([r, { ...r, id: 2, groupId: 2, functionCode: 4 }], [p(1000, 0, 10), p(0, 0, 2), p(0, 0, 50, 'input-register')], new Set([1, 2]))
assert.deepEqual(result.find(s => s.id === 1)!.samples, [[t, 2], [t + 1000, 10]])
assert.deepEqual(result.find(s => s.id === 2)!.samples, [[t, 50]])
assert.deepEqual(nearestHistorySample(result[0].samples, t + 800), [t + 1000, 10])
assert.equal(nearestHistorySample([], t), undefined)
const wide = decodeHistorySeries([{ ...r, dataType: 'uint32' }], [p(0, 0, 1), p(0, 1, 2), p(1000, 0, 2)], new Set([1]))
assert.deepEqual(wide[0].samples, [[t, 65538], [t + 1000, null]], 'incomplete multiword data breaks the line')
assert.equal(decodeHistorySeries([{ ...r, dataType: 'hex16' }], [p(0, 0, 1)], new Set([1])).length, 0)
assert.equal(decodeHistorySeries([r], [p(0, 0, 1)], new Set()).length, 0)
assert.equal(decodeHistorySeries([r], [{ ...p(0, 0, 1), ts: 'invalid' }], new Set([1])).length, 0)
const gaps = decodeHistorySeries([r], [0, 1000, 2000, 3000, 60000].map(n => p(n, 0, n)), new Set([1]))
assert.equal(gaps[0].gapMs, 3000)
// Execute actual historical SVG series expressions, without importing App or bootstrapping services.
for (const [samples, gapMs, segments, expected] of [
  [[], 5000, undefined, []], [[[0, null], [1, NaN], [2, Infinity]], 5000, undefined, []],
  [[[0, 0]], 5000, undefined, [[0, 0]]], [[[0, 0], [1, null], [2, -1]], 5000, undefined, [[0, 0], [2, -1]]],
  [[[0, 0], [0, 0]], 5000, undefined, [[0, 0]]], [[[0, 0], [0, 1]], 5000, undefined, []],
  [[[0, 0], [18000, 0]], 5400, [[0, 0], [18000, 0]], []],
  [[[0, 0], [1000, 0]], 5400, [[0, 0], [1000, 1]], [[0, 0], [1000, 0]]],
  [[[0, 0], [18000, 0]], 5400, undefined, [[0, 0], [18000, 0]]],
  [[[18000, 0]], 5400, [[0, 0], [18000, 0], [36000, 0]], [[18000, 0]]]
] as Array<[history.HistorySample[], number, Array<[number, number]> | undefined, Array<[number, number]>]>) {
  const before = samples.map(([time, value]) => [time, value]); assert.deepEqual(history.isolatedHistoryPoints(samples, gapMs, segments), expected); assert.deepEqual(samples, before)
}
{
  const tree = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let found: ts.Node | undefined; ts.forEachChild(node, child => { found ??= find(child, predicate) }); return found }
  const component = find(tree, node => ts.isFunctionDeclaration(node) && node.name?.text === 'ChartBody')!
  const declaration = (name: string) => find(component, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration | undefined
  const drawn = find(component, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map' && node.expression.expression.getText(tree).startsWith('visibleSeries.filter') && node.getText(tree).includes('data-history-series'))!
  const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(tree) + ')', { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
  const decoded = decodeHistorySeries([r], [{ ...p(0, 0, 0), quality: 'good' }, { ...p(1000, 0, 0), quality: 'bad' }, { ...p(2000, 0, 0), quality: 'good' }], new Set([1]))[0]
  assert.deepEqual(decoded.samples, [[t, 0], [t + 1000, null], [t + 2000, 0]])
  const series = { ...decoded, ...historySampleStats(decoded.samples), color: 'red' }
  const env: Record<string, unknown> = { React, visibleSeries: [series], hidden: new Set(), historyLineStarts, isolatedHistoryPoints: history.isolatedHistoryPoints, x: (time: number) => time - t, y: (value: number) => value, displayValue: (value: number) => value }
  env.pathFor = evaluate(declaration('pathFor')!.initializer!, env)
  const marker = declaration('markerPathFor'); if (marker) env.markerPathFor = evaluate(marker.initializer!, env)
  const svg = renderToStaticMarkup(React.createElement('svg', null, evaluate(drawn, env)))
  const paths = [...svg.matchAll(/data-history-markers="\d+" d="([^"]*)"/g)]
  const markers = (svg.match(/<circle/g) ?? []).length + paths.reduce((sum, path) => sum + (path[1].match(/Z/g) ?? []).length, 0)
  assert.equal(markers, 2, 'historical zero samples isolated by bad quality must have visible markers')
  assert(!/data-history-series="1" d="[^"]*L/.test(svg), 'bad-quality gap stays disconnected')
  const paint = (visibleSeries: unknown[], hidden = new Set<number>(), relative = false) => {
    const input = { ...env, visibleSeries, hidden, displayValue: evaluate(declaration('displayValue')!.initializer!, { relative }) }
    return renderToStaticMarkup(React.createElement('svg', null, evaluate(drawn, { ...input, pathFor: evaluate(declaration('pathFor')!.initializer!, input), markerPathFor: evaluate(marker!.initializer!, input) })))
  }
  const markerCount = (html: string) => [...html.matchAll(/data-history-markers="\d+" d="([^"]*)"/g)].reduce((sum, path) => sum + (path[1].match(/Z/g) ?? []).length, 0)
  const separated = { ...series, samples: [[t, 0], [t + 1000, 0]], segments: [[t, 0], [t + 1000, 1]] }
  const splitSvg = paint([separated]); assert.equal(markerCount(splitSvg), 2); assert(!/data-history-series="1" d="[^"]*L/.test(splitSvg))
  const connected = { ...series, samples: [[t, 0], [t + 18000, 0]], gapMs: 5400, segments: [[t, 0], [t + 18000, 0]] }
  const sameSvg = paint([connected]); assert.equal(markerCount(sameSvg), 0); assert(/data-history-series="1" d="[^"]*L/.test(sameSvg), 'sparse display samples in one source segment stay connected')
  assert.equal(markerCount(paint([series], new Set([1]))), 0, 'hidden series does not leave visible markers')
  const relativeSvg = paint([series], new Set(), true); assert.equal(markerCount(relativeSvg), 2); assert(relativeSvg.includes(',50.00a3,3'), 'markers use the same constant-series relative transform as the line')
  const dense = { ...series, samples: Array.from({ length: 2400 }, (_, i) => [t + i, i % 2 ? null : 0]) }
  const denseSvg = paint([dense]); assert.equal(markerCount(denseSvg), 1200); assert.equal((denseSvg.match(/<path/g) ?? []).length, 2, 'history markers remain one aggregate path per series')
  console.log('HISTORY MARKER SVG OK: decoded quality-gap zeros, explicit/sparse source segments, hidden series, relative transform and 1200 isolated markers in two paths; expression/SSR only.')
}
console.log('HISTORY CURVE TEST OK: area separation, ordered timestamps, nearest reads, partial words, missing data and gaps')
