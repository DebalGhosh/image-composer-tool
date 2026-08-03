import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface CollapsibleProps {
  /** When true, the panel is (or is animating toward) open. */
  open: boolean
  /** Content — kept mounted while the panel is open OR still animating closed. */
  children: ReactNode
  /** Class names for the outer wrapper (margin, padding, etc). */
  className?: string
  /** Animation duration in ms. Defaults to 260ms. */
  duration?: number
}

/**
 * Collapsible — animates its children in/out with a max-height + opacity
 * transition when `open` toggles.
 *
 * Height animation trick:
 *   CSS can't transition `height: auto`, so we measure the content's
 *   scrollHeight and drive `max-height` between 0 and that value. Content
 *   height is re-measured on every resize (ResizeObserver on the inner
 *   div) so accordion contents that themselves grow don't get clipped.
 *
 * Mount lifecycle:
 *   Children are unmounted only AFTER the closing animation finishes, so
 *   consumers don't see a snap-cut. During the exit we hold the last-known
 *   children in state until the transition end.
 *
 * Overflow:
 *   `overflow: hidden` clips content during animation. When fully open we
 *   swap to `overflow: visible` so absolute-positioned descendants (e.g. a
 *   dropdown menu) aren't clipped by the wrapper. The swap happens on
 *   transition end.
 */
export function Collapsible({
  open,
  children,
  className,
  duration = 260,
}: CollapsibleProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [naturalHeight, setNaturalHeight] = useState(0)
  // Whether the wrapper should currently render its children. Diverges from
  // `open` during the closing transition: we render children until the
  // animation completes, then unmount.
  const [rendered, setRendered] = useState(open)
  // Overflow toggle: hidden during animation, visible when fully open (so
  // absolutely-positioned descendants aren't clipped).
  const [overflowVisible, setOverflowVisible] = useState(open)

  // Measure content on mount and whenever it resizes.
  useLayoutEffect(() => {
    if (!contentRef.current) return
    const el = contentRef.current
    const measure = () => setNaturalHeight(el.scrollHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rendered])

  // Sync `rendered` with `open`. On open, render immediately. On close,
  // keep children mounted through the animation, then unmount.
  useEffect(() => {
    if (open) {
      setRendered(true)
      // Also keep overflow hidden until the transition completes, so entrance
      // animation clips cleanly.
      setOverflowVisible(false)
    } else {
      // Kick off closing: overflow goes hidden immediately so the exit clips.
      setOverflowVisible(false)
      const t = setTimeout(() => setRendered(false), duration)
      return () => clearTimeout(t)
    }
  }, [open, duration])

  // After the opening transition ends, switch to overflow:visible.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => setOverflowVisible(true), duration)
    return () => clearTimeout(t)
  }, [open, duration])

  return (
    <div
      className={className}
      style={{
        maxHeight: open ? naturalHeight : 0,
        opacity: open ? 1 : 0,
        overflow: overflowVisible ? 'visible' : 'hidden',
        transition:
          'max-height ' + duration + 'ms cubic-bezier(0.22, 0.7, 0.32, 1), ' +
          'opacity ' + duration + 'ms ease',
      }}
      aria-hidden={!open}
    >
      <div ref={contentRef}>{rendered ? children : null}</div>
    </div>
  )
}
