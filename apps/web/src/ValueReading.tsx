import { useEffect, useRef, type ReactNode } from 'react'

/** Animate only a changed valid reading. Repeated timestamps and initial loads stay quiet. */
export function ValueReading({ value, fresh, identity, children }: { value: string | null; fresh: boolean; identity: string; children?: ReactNode }) {
  const element = useRef<HTMLSpanElement>(null)
  const previous = useRef<{ value: string | null; fresh: boolean; identity: string } | null>(null)
  useEffect(() => {
    const before = previous.current
    const valid = fresh && value != null && !['—', 'NaN', 'Infinity', '-Infinity'].includes(value)
    previous.current = { value, fresh: valid, identity }
    if (!element.current || !valid || !before?.fresh || before.value == null || before.identity !== identity || before.value === value) return
    const color = getComputedStyle(element.current).getPropertyValue('--accent-soft').trim()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const frames = reduced ? [{ backgroundColor: color }, { backgroundColor: color }] : [{ backgroundColor: color }, { backgroundColor: color, offset: 0.3 }, { backgroundColor: 'transparent' }]
    const animation = element.current.animate(frames, { duration: 1000, easing: 'ease-out' })
    return () => animation.cancel()
  }, [value, fresh, identity])
  return <span ref={element} className="rt-reading value-reading" tabIndex={0}>{value ?? '—'}{children}</span>
}
