import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

type Notice = { error: boolean; text: string }
type Toast = Notice & { id: number; dismissLabel: string }
let nextId = 0
let queue: Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const snapshot = () => queue
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function emit() { for (const listener of listeners) listener() }
export function dismissOperationNotice(id: number) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  queue = queue.filter(item => item.id !== id)
  emit()
}
export function showOperationNotice(notice: Notice, dismissLabel: string) {
  const id = ++nextId
  queue = [{ ...notice, id, dismissLabel }, ...queue]
  timers.set(id, setTimeout(() => dismissOperationNotice(id), notice.error ? 6000 : 3000))
  emit()
}
export function OperationNotifications() {
  const notices = useSyncExternalStore(subscribe, snapshot)
  if (!notices.length) return null
  return createPortal(<div className="operation-toast-stack" aria-label="操作提示">
    {notices.map(notice => <div key={notice.id} className={'operation-feedback operation-toast' + (notice.error ? ' error' : '')} role={notice.error ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button type="button" aria-label={notice.dismissLabel} onClick={() => dismissOperationNotice(notice.id)}>×</button>
    </div>)}
  </div>, document.body)
}
