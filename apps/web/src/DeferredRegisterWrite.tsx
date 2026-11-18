import { lazy, Suspense } from 'react'
import type { RegisterWriteSource } from '../../../packages/core/src/guarded-register-write'
const Modal = lazy(() => import('./RegisterWriteModal'))
export function DeferredRegisterWrite(props: { source: RegisterWriteSource; currentValue: string; english: boolean; onClose: () => void }) {
  return <Suspense fallback={<div className="modal-mask"><div className="modal" role="dialog"><p role="status">{props.english ? 'Loading write confirmation…' : '正在加载写入确认…'}</p><button className="btn" onClick={props.onClose}>{props.english ? 'Close' : '关闭'}</button></div></div>}><Modal {...props} /></Suspense>
}
