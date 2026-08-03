import { useEffect, useRef } from 'react'
import { usePanelAnimation } from '@/hooks/usePanelAnimation'

/**
 * Slides the review pane open when the cascade completes, and shut when it stops
 * being complete.
 *
 * ⚠️ `snapWhenClose: false` IS THE ONE THING THAT DIFFERS from the toggle
 * chevrons on the Interactive and Advanced pages, and it is deliberate: this
 * animation has always RETURNED WITHOUT RESIZING when the pane already sits
 * within 0.5% of its target, where the chevrons snap. Passing `true` here would
 * make the pane twitch whenever a field edit re-completes an already-complete
 * cascade. See hooks/usePanelAnimation.
 *
 * The FIRST render never animates: the panel already mounts at its correct
 * default size, so `prevCompleteRef` starts null purely to swallow that pass.
 * Animating it would show the pane sliding in on every page load.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function usePreviewPaneAnimation(complete: boolean) {
  /*
   * Preview-pane drop-in animation.
   *
   * The preview panel starts collapsed to a tiny strip (6%) and slides open
   * to a comfortable 45% when the cascade is complete — reversing when the
   * user un-picks a field. The animation is driven by requestAnimationFrame
   * imperatively via the panel's `resize(size)` handle because the
   * library doesn't animate size changes on its own.
   */
  const {
    panelRef: rightPanelRef,
    animateTo: animatePanel,
    cancel: cancelAnimation,
  } = usePanelAnimation()
  const prevCompleteRef = useRef<boolean | null>(null)

  useEffect(() => {
    // Skip on first render: the panel already renders at its default size, no
    // animation needed. We remember the initial state so subsequent flips can
    // animate.
    if (prevCompleteRef.current === null) {
      prevCompleteRef.current = complete
      return
    }
    if (prevCompleteRef.current === complete) return
    prevCompleteRef.current = complete

    // snapWhenClose: false — this effect has always RETURNED without resizing
    // when the pane is already within 0.5% of the target, unlike the toggle
    // chevrons on the other two pages which snap. Preserved deliberately; see
    // hooks/usePanelAnimation.
    animatePanel(complete ? 45 : 0, complete ? 520 : 380, { snapWhenClose: false })

    return cancelAnimation
  }, [complete, animatePanel, cancelAnimation])

  return rightPanelRef
}
