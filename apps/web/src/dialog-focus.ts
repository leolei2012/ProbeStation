const controls = (form: HTMLFormElement) => Array.from(form.querySelectorAll<HTMLElement>('button:enabled,input:enabled,select:enabled,textarea:enabled')).filter(item => item.tabIndex >= 0)

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
