import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCommandPalette } from './useCommandPalette'

/**
 * The offsetParent guard is the reason this hook exists as its own module.
 *
 * All four pages stay MOUNTED — App.tsx hides the inactive ones with `hidden`
 * rather than unmounting, so the composer drafts survive tab switches. This
 * listener is on `document`, which means a Cmd+K pressed while another tab is
 * showing still reaches the hidden Interactive page's handler. The guard is what
 * stops it claiming the shortcut.
 *
 * jsdom does not compute layout, so `offsetParent` is always null there. These
 * tests therefore define it explicitly per case — which is also the honest way
 * to test the contract, since what matters is "null ⇒ ignore, non-null ⇒ claim".
 */

function press(key = 'k', mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }),
  )
}

/** Attach a root element whose offsetParent we control. */
function attach(root: { current: HTMLDivElement | null }, visible: boolean) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => (visible ? document.body : null),
  })
  root.current = el
  return el
}

describe('useCommandPalette', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useCommandPalette())
    expect(result.current.open).toBe(false)
  })

  it('opens on Cmd+K when the page is VISIBLE', () => {
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    act(() => press('k', { metaKey: true }))
    expect(result.current.open).toBe(true)
  })

  it('opens on Ctrl+K too — Linux and Windows', () => {
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    act(() => press('k', { ctrlKey: true }))
    expect(result.current.open).toBe(true)
  })

  it('IGNORES Cmd+K when the page is HIDDEN (offsetParent null)', () => {
    // The whole point. Without this the shortcut fires from every tab.
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, false)
    })
    act(() => press('k', { metaKey: true }))
    expect(result.current.open).toBe(false)
  })

  it('ignores the keystroke before the ref is attached', () => {
    const { result } = renderHook(() => useCommandPalette())
    act(() => press('k', { metaKey: true }))
    expect(result.current.open).toBe(false)
  })

  it('requires a modifier — a bare "k" must not open it', () => {
    // Otherwise typing 'k' in any text field would open the dialog.
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    act(() => press('k', {}))
    expect(result.current.open).toBe(false)
  })

  it('ignores other keys with the modifier held', () => {
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    for (const key of ['j', 'p', 'Enter', 'K']) {
      act(() => press(key, { metaKey: true }))
      expect(result.current.open, key).toBe(false)
    }
  })

  it('lets the caller close it', () => {
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    act(() => press())
    expect(result.current.open).toBe(true)
    act(() => result.current.setOpen(false))
    expect(result.current.open).toBe(false)
  })

  it('removes its document listener on unmount', () => {
    const { result, unmount } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    unmount()
    // No throw, and no state update on an unmounted hook (React would warn).
    expect(() => press()).not.toThrow()
  })

  it('preventDefault()s so the browser does not steal Cmd+K', () => {
    // Chrome focuses the address bar on Ctrl+K; the dialog must win.
    const { result } = renderHook(() => useCommandPalette())
    act(() => {
      attach(result.current.rootRef, true)
    })
    const ev = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      document.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
  })
})
