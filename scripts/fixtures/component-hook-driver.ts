import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import ts from 'typescript'

// Deterministic local hook/effect driver only; not React DOM or a browser.
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText

const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
export function hookDriver(file: string, name: string, scope: Record<string, unknown>, initialProps: any, commit?: (tree: any) => void) {
  const fileSource = ts.createSourceFile(file, readFileSync(new URL('../../apps/web/src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = find(fileSource, node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  const cells: any[] = [], dependencies: any[][] = [], cleanup = new Map<number, () => void>()
  let cursor = 0, effects: Array<() => void> = [], tree: any, currentProps = initialProps, disposed = false, lateWrites = 0
  const useState = (init: any) => { const id = cursor++; if (!(id in cells)) cells[id] = typeof init === 'function' ? init() : init; return [cells[id], (value: any) => { if (disposed) { lateWrites++; return }; cells[id] = typeof value === 'function' ? value(cells[id]) : value }] }
  const useRef = (init: any) => useState(() => ({ current: init }))[0]
  const useEffect = (effect: () => void | (() => void), deps: any[]) => { const id = cursor++; if (!dependencies[id] || deps.some((v, i) => !Object.is(v, dependencies[id][i]))) effects.push(() => { cleanup.get(id)?.(); const next = effect(); if (next) cleanup.set(id, next); else cleanup.delete(id) }); dependencies[id] = deps }
  const env = { React, useState, useRef, useEffect, useId: () => useState('mock-title')[0], ...scope }
  const component = new Function(...Object.keys(env), compile('return (' + declaration.getText(fileSource).replace(/^export /, '') + ')'))(...Object.values(env))
  const render = (next = currentProps) => { assert(!disposed); currentProps = next; cursor = 0; effects = []; tree = component(currentProps); commit?.(tree); for (const effect of effects) effect(); return tree }
  render()
  return { render, get tree() { return tree }, get lateWrites() { return lateWrites }, dispose() { if (disposed) return; disposed = true; for (const fn of cleanup.values()) fn(); cleanup.clear() }, one(type: any, predicate: (props: any) => boolean = () => true) { const item = elements(tree).find(node => node.type === type && predicate(node.props)); assert(item, 'control missing'); return item } }
}
