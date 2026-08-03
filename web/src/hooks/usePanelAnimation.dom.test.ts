import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { usePanelAnimation } from '@/hooks/usePanelAnimation'

/**
 * Characterisation tests for usePanelAnimation — the hook that unified three
 * copies of the pane-width rAF animation.
 *
 * The behaviour that MUST be preserved exactly:
 *   1. easeOutCubic, 1 - (1-t)^3 — not linear, not easeInOut.
 *   2. The final frame lands exactly on the target (t clamps to 1).
 *   3. A second animateTo cancels the first rather than interleaving.
 *   4. The 0.5% near-target case snaps OR no-ops, per snapWhenClose. This is
 *      the one place the three original copies disagreed.
 *   5. An in-flight frame is cancelled on unmount.
 */

/** Fake panel handle that records every resize() call. */
function fakeHandle(initial: number) {
  const sizes: number[] = []
  let current = initial
  const handle: ImperativePanelHandle = {
    getSize: () => current,
    resize: (n: number) => {
      current = n
      sizes.push(n)
    },
    collapse: () => {},
    expand: () => {},
    isCollapsed: () => false,
    isExpanded: () => true,
    getId: () => 'fake',
  } as unknown as ImperativePanelHandle
  return { handle, sizes, get current() { return current } }
}

/**
 * Drive requestAnimationFrame manually so the easing curve can be sampled at
 * exact timestamps. jsdom has no real rAF clock, and a real one would make these
 * assertions timing-dependent.
 */
let queued: Array<(t: number) => void> = []
let rafId = 0
const cancelled = new Set<number>()

beforeEach(() => {
  queued = []
  rafId = 0
  cancelled.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queued.push(cb)
    return ++rafId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.add(id)
  })
})
afterEach(() => vi.unstubAllGlobals())

/** Run the single pending frame at the given timestamp. */
function tick(now: number) {
  const cb = queued.shift()
  if (cb) act(() => cb(now))
}

describe('easing curve', () => {
  it('follows easeOutCubic, sampled at t = 0.25 / 0.5 / 0.75 / 1', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(100, 400) // 0 -> 100 over 400ms
    })

    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    for (const t of [0.25, 0.5, 0.75, 1]) {
      tick(1000 + 400 * t)
      expect(f.sizes.at(-1)).toBeCloseTo(100 * ease(t), 6)
    }
  })

  it('lands exactly on the target on the final frame', () => {
    const f = fakeHandle(28)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(0, 320)
    })
    tick(320)
    expect(f.sizes.at(-1)).toBe(0)
  })

  it('clamps past the duration rather than overshooting', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 520)
    })
    tick(99_999)
    expect(f.sizes.at(-1)).toBe(45)
  })

  it('stops queueing frames once it reaches the target', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 100)
    })
    tick(50)
    expect(queued.length).toBe(1) // mid-flight: another frame pending
    tick(100)
    expect(queued.length).toBe(0) // done: nothing further queued
  })
})

describe('snapWhenClose — the one place the three copies disagreed', () => {
  it('snaps to the target when within 0.5 (InteractivePage toggle / BuildImagePage)', () => {
    // A pane sitting at 0.3% must land exactly on 0 or a sliver stays visible.
    const f = fakeHandle(0.3)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(0, 320, { snapWhenClose: true })
    })
    expect(f.sizes).toEqual([0])
    expect(queued.length).toBe(0) // snapped, never animated
  })

  it('leaves the pane untouched when within 0.5 (BasicPage / auto-open effects)', () => {
    const f = fakeHandle(0.3)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(0, 320, { snapWhenClose: false })
    })
    expect(f.sizes).toEqual([])
    expect(queued.length).toBe(0)
  })

  it('shares one in-flight frame across snap and no-snap calls', () => {
    // InteractivePage drives ONE pane from two places — a manual toggle (snaps)
    // and a `complete`-flip auto-open effect (does not). They must share a
    // single rAF slot so a flip mid-toggle cannot leave two loops driving the
    // same handle from different `from` values.
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 520, { snapWhenClose: true })
    })
    tick(100)
    const inFlight = rafId
    act(() =>
      result.current.animateTo(0, 380, { snapWhenClose: false }),
    )
    expect(cancelled.has(inFlight)).toBe(true)
  })

  it('defaults to snapping', () => {
    const f = fakeHandle(45.2)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 420)
    })
    expect(f.sizes).toEqual([45])
  })

  it('animates normally when the gap is exactly at the 0.5 boundary', () => {
    // The guard is `< 0.5`, so a gap of exactly 0.5 animates.
    const f = fakeHandle(0.5)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(0, 100)
    })
    expect(queued.length).toBe(1)
  })
})

describe('cancel-in-flight', () => {
  it('cancels the previous animation when a new one starts', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 520)
    })
    const firstId = rafId
    tick(100) // mid-flight
    act(() => result.current.animateTo(0, 380)) // reverse before finishing
    expect(cancelled.has(rafId - 1)).toBe(true)
    expect(firstId).toBeGreaterThan(0)
  })

  it('cancels an in-flight frame on unmount', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result, unmount } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 520)
    })
    const inFlight = rafId
    unmount()
    expect(cancelled.has(inFlight)).toBe(true)
  })

  it('exposes cancel() for callers that need it explicitly', () => {
    const f = fakeHandle(0)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() => usePanelAnimation())
    act(() => {
      result.current.panelRef.current = f.handle
      result.current.animateTo(45, 520)
    })
    const inFlight = rafId
    act(() => result.current.cancel())
    expect(cancelled.has(inFlight)).toBe(true)
  })
})

describe('guards', () => {
  it('no-ops when the panel ref is not attached yet', () => {
    const { result } = renderHook(() => usePanelAnimation())
    expect(() => act(() => result.current.animateTo(45, 420))).not.toThrow()
    expect(queued.length).toBe(0)
  })
})
