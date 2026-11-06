import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { capturePointEditBaseline } from '../../../packages/core/src/point-settings-edit'
import { AliasEdit } from './alias-edit'

export function AliasCell({ point, group, device, placeholder, put, get, onRefresh }: { point: unknown; group: unknown; device: unknown; placeholder: string; put: (url: string, body: unknown, signal: AbortSignal) => Promise<unknown>; get: (url: string, signal: AbortSignal) => Promise<unknown>; onRefresh: () => void }) {
  const snapshot = capturePointEditBaseline(point, group, device)
  // Alias writes never compare the enum; do not stringify a potentially huge opaque mapping on refresh.
  const expected = capturePointEditBaseline({ ...snapshot.point, enumJson: null }, snapshot.group, snapshot.device), key = JSON.stringify(expected)
  const [editor] = useState(() => new AliasEdit(expected))
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot)
  useEffect(() => { editor.observe(expected) }, [editor, key])
  const busy = state.phase === 'saving' || state.phase === 'loading'
  return <div className="inline-edit alias-editor"><input className="cell-input" aria-label={placeholder} disabled={busy} value={state.value} placeholder={placeholder}
    onChange={event => editor.edit(event.target.value)} onBlur={() => { void editor.save(put, onRefresh) }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    {state.message && <small className="alias-edit-feedback" role="status">{state.message}</small>}
    {state.phase === 'blocked' && <button type="button" className="btn btn-sm" onClick={() => { void editor.reload(get) }}>放弃草稿并重新载入</button>}
  </div>
}
