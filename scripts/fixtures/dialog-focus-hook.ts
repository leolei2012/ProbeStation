import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { bindDialogReturnFocus, restoreDialogFocus } from '../../apps/web/src/dialog-focus.ts'

// Evaluate the actual local hook with the same controlled hook cells as its editor.
// This is not a React DOM renderer, native focus implementation or browser.
const source = ts.createSourceFile('dialog-focus.ts', readFileSync(new URL('../../apps/web/src/dialog-focus.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useDraftDialogFocus')
assert(hook)
const code = ts.transpileModule('return (' + hook.getText(source).replace(/^export /, '') + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
export function draftDialogFocusHook(hooks: Record<string, unknown>) {
  const env = { ...hooks, bindDialogReturnFocus, restoreDialogFocus }
  return new Function(...Object.keys(env), code)(...Object.values(env))
}
export const withDraftDialogFocus = (scope: Record<string, unknown>) => (hooks: Record<string, unknown>) => ({ ...scope, useDraftDialogFocus: draftDialogFocusHook({ ...hooks, document: scope.document }) })
