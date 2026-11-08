import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import ts from 'typescript'
import { PointDraftDiscard } from '../../apps/web/src/PointDraftDiscard.tsx'

// Render our own hook-free forwardRef body, not React's private renderer or a real DOM.
const source = ts.createSourceFile('discard.tsx', readFileSync(new URL('../../apps/web/src/PointDraftDiscard.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let body!: ts.FunctionExpression
const visit = (node: ts.Node) => { if (ts.isFunctionExpression(node) && node.name?.text === 'PointDraftDiscard') body = node; ts.forEachChild(node, visit) }; visit(source); assert(body)
const discard = new Function('React', ts.transpileModule('return (' + body.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(React)
export function focusDocument() {
  const document: any = { activeElement: null, body: null }
  document.body = { isConnected: true, focus() { document.activeElement = this } }
  document.activeElement = document.body
  return document
}
/** Small connected/fieldset/focus model. No layout, native event dispatch or assistive technology. */
export function draftFocusModel(document = focusDocument()) {
  const nodes = new Map<string, any>(); let current: any[] = [], refs: any[] = [], form: any
  function commit(tree: any) {
    for (const node of nodes.values()) node.isConnected = false
    for (const ref of refs) ref.current = null
    refs = []; current = []
    function walk(element: any, path: string, parent: any = null, inherited = false) {
      if (Array.isArray(element)) { element.forEach((child, index) => walk(child, path + '.' + index, parent, inherited)); return }
      if (!React.isValidElement(element)) return
      const props: any = element.props
      if (element.type === PointDraftDiscard) { walk(discard(props, (element as any).ref), path + '.confirm', parent, inherited); return }
      if (typeof element.type !== 'string') return // Opaque enum/serial child controls are not modeled.
      const tag = element.type, id = path + ':' + tag, fresh = !nodes.has(id)
      const node = nodes.get(id) ?? { tag, isConnected: false, ownerDocument: document, parent: null,
        focus() { if (this.isConnected && !this.unavailable) document.activeElement = this },
        matches(selector: string) { assert.equal(selector, ':disabled'); return this.unavailable },
        contains(other: any) { for (let item = other; item; item = item.parent) if (item === this) return true; return false },
        querySelectorAll(selector: string) { assert(selector.includes('button')); return current.filter(item => item !== this && this.contains(item) && ['input', 'select', 'button', 'textarea'].includes(item.tag) && !item.unavailable) },
      }
      Object.assign(node, { props, isConnected: true, parent, unavailable: inherited || !!props.disabled, disabled: !!props.disabled, tabIndex: props.tabIndex ?? 0 })
      nodes.set(id, node); current.push(node); if (tag === 'form') form = node
      const ref = (element as any).ref
      if (ref && typeof ref === 'object') { ref.current = node; refs.push(ref) }
      if (fresh && props.autoFocus) node.focus()
      walk(props.children, path + '.children', node, inherited || tag === 'fieldset' && !!props.disabled)
    }
    walk(tree, 'root')
    if (!document.activeElement?.isConnected) document.activeElement = document.body
  }
  const control = (predicate: (node: any) => boolean) => { const result = current.find(predicate); assert(result, 'focus control missing'); return result }
  return { document, commit, get form() { return form },
    field(label: string) { return control(node => node.props['aria-label'] === label && ['input', 'select'].includes(node.tag)) },
    close() { return control(node => node.props.className === 'modal-close') },
    button(text: string) { return control(node => node.tag === 'button' && node.props.children === text) },
    confirmation() { return current.find(node => node.props.className === 'point-draft-discard') },
    confirmationText() { const section = current.find(node => node.props.className === 'point-draft-discard'); return current.find(node => node.tag === 'p' && node.parent === section)?.props.children ?? '' },
    key(editor: any, key: string, shiftKey = false, composing = false, defaultPrevented = false, modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
      const event = { key, shiftKey, defaultPrevented, ...modifiers, stopped: false, nativeEvent: { isComposing: composing }, currentTarget: form,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
      editor.driver.one('form').props.onKeyDown(event); editor.driver.render(); return event
    },
  }
}
