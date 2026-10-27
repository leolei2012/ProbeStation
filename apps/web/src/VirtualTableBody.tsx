import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Uniform desktop rows only; mobile cards and small groups retain the normal document layout. */
export function VirtualTableBody<T>({ items, columns, children }: { items: T[]; columns: number; children: (item: T) => ReactNode }) {
  const body = useRef<HTMLTableSectionElement>(null)
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 769px)').matches)
  const [viewport, setViewport] = useState({ top: 0, height: 560 })
  const [rowHeight, setRowHeight] = useState(58)
  const virtual = desktop && items.length > 200
  useEffect(() => {
    const media = matchMedia('(min-width: 769px)'), update = () => setDesktop(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    const wrapper = body.current?.closest<HTMLElement>('.register-table-scroll')
    if (!wrapper || !virtual) return
    wrapper.classList.add('virtual-register-scroll')
    const measure = () => setViewport({ top: wrapper.scrollTop, height: wrapper.clientHeight })
    wrapper.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure); observer.observe(wrapper); measure()
    return () => { observer.disconnect(); wrapper.removeEventListener('scroll', measure); wrapper.classList.remove('virtual-register-scroll') }
  }, [virtual])
  const start = virtual ? Math.max(0, Math.min(items.length - 1, Math.floor(viewport.top / rowHeight) - 10)) : 0
  const end = virtual ? Math.min(items.length, start + Math.ceil(viewport.height / rowHeight) + 20) : items.length
  useLayoutEffect(() => {
    if (!virtual) return
    const row = body.current?.querySelector<HTMLElement>('tr:not([data-spacer])')
    if (!row) return
    const measure = () => { const height = row.getBoundingClientRect().height; if (height > 0) setRowHeight(height) }
    const observer = new ResizeObserver(measure); observer.observe(row); measure()
    return () => observer.disconnect()
  }, [virtual, start, items])
  const spacer = (height: number) => <tr data-spacer aria-hidden="true"><td colSpan={columns} style={{ height, padding: 0, border: 0 }} /></tr>
  return <tbody ref={body} aria-rowcount={items.length}>
    {virtual && start > 0 && spacer(start * rowHeight)}
    {items.slice(start, end).map(children)}
    {virtual && end < items.length && spacer((items.length - end) * rowHeight)}
  </tbody>
}
