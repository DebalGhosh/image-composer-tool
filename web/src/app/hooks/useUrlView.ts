import { useEffect, useState } from 'react'
import { readUrlState, replaceUrlState } from '@/lib/urlState'
import type { View } from '@/lib/urlState'

/**
 * Keeps the active tab and the URL in step, both ways.
 *
 * ⚠️ THIS IS NOT A ROUTER AND MUST NOT BECOME ONE. All four pages stay MOUNTED
 * simultaneously behind `hidden={view !== …}`, which is load-bearing twice over:
 *   - InteractivePage's Cmd+K handler detects "my tab is off screen" by reading
 *     `offsetParent === null`, which only works because the element exists in a
 *     `display: none` subtree rather than being unmounted;
 *   - the composer drafts are store-lifted but their LOCAL state (scroll
 *     position, open accordions, in-progress edits) survives a tab switch purely
 *     because the components are never torn down.
 * A router would unmount the inactive pages and break both. See
 * .claude/UI-LAYOUT.md and the refactor brief's guardrail on the four-page mount.
 *
 * `replaceUrlState` rather than push: tab switches are not history entries, so
 * Back leaves the app instead of walking the tabs the user visited. The popstate
 * listener still handles a real Back/Forward across an external navigation.
 *
 * The initial view is read SYNCHRONOUSLY during the first render, not in an
 * effect, so a deep link paints the right tab immediately.
 *
 * Extracted verbatim from App in FE-7d.
 */
export function useUrlView() {
  const initialUrl = readUrlState()
  const [view, setView] = useState<View>(initialUrl.view)

  useEffect(() => {
    replaceUrlState({ view })
  }, [view])

  // Handle browser back/forward: re-parse the URL and update view.
  useEffect(() => {
    const onPop = () => {
      const u = readUrlState()
      setView(u.view)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  return { view, setView, initialUrl }
}
