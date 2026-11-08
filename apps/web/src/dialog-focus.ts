import { useEffect, useState, type KeyboardEvent } from 'react'
import type { PointCloseAction, PointDraftCloseGuard } from './point-draft-close'

const controls = (form: HTMLFormElement) => Array.from(form.querySelectorAll<HTMLElement>(':is(button,input,select,textarea):enabled')).filter(item => item.tabIndex >= 0)
type DraftDialogFocus = [
  dialog: { current: HTMLFormElement | null }, resumeButton: { current: HTMLButtonElement | null },
  closeTrigger: [target: HTMLElement | null, restore: boolean], opener: HTMLElement | null,
]

/** Local editor lifecycle only: no global modal stack or navigation ownership. */
export function useDraftDialogFocus(busy: boolean, discarding: boolean) {
  const [focus] = useState<DraftDialogFocus>(() => [
    { current: null }, { current: null }, [null, false],
    typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null,
  ])
  const [dialog, resumeButton, closeTrigger, opener] = focus
  useEffect(() => {
    if (busy) dialog.current?.focus()
    else if (discarding) resumeButton.current?.focus()
    else if (closeTrigger[1]) { closeTrigger[1] = false; restoreDialogFocus(dialog.current, closeTrigger[0]) }
    return bindDialogReturnFocus(dialog.current, opener)
  }, [focus, discarding, busy])
  return focus
}

/** Only reclaim otherwise empty focus after actual removal, never another modal's focus. */
export function bindDialogReturnFocus(form: HTMLFormElement | null, opener: HTMLElement | null) {
  return () => {
    if (!form || form.isConnected || !opener || !opener.isConnected) return
    const document = form.ownerDocument
    if (document.activeElement === document.body && !document.querySelector('[aria-modal="true"]') && opener.ownerDocument === document && !opener.matches(':disabled')) opener.focus()
  }
}

export function draftDialogKey(event: KeyboardEvent<HTMLFormElement>, guard: PointDraftCloseGuard, busy: boolean, close: (action: PointCloseAction) => void, requestClose: () => void) {
  if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (guard.confirming) close(guard.resume(busy)); else requestClose() }
  else trapDialogTab(event)
}

/** Current native form controls only; not a general shadow-DOM tabbability engine. */
export function restoreDialogFocus(form: HTMLFormElement | null, preferred: HTMLElement | null) {
  if (!form) return
  const target = preferred?.isConnected && form.contains(preferred) && !preferred.matches(':disabled') ? preferred : controls(form)[0] ?? form
  target.focus()
}

export function trapDialogTab(event: { key: string; shiftKey: boolean; defaultPrevented?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; currentTarget: HTMLFormElement; preventDefault(): void }) {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  const form = event.currentTarget, items = controls(form), active = form.ownerDocument.activeElement
  if (!items.length || active === form || active === items[event.shiftKey ? 0 : items.length - 1]) {
    event.preventDefault(); (items[event.shiftKey ? items.length - 1 : 0] ?? form).focus()
  }
}
