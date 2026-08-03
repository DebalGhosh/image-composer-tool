import { useEffect, useMemo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore, cascadingOptions } from '@/store'
import { useYamlFullscreenActive } from '@/features/yaml'
import { nextAutoFill } from './model/autofill'
import { useDispatchBuild } from './hooks/useDispatchBuild'
import { useLiveReview } from './hooks/useLiveReview'
import { usePreviewPaneAnimation } from './hooks/usePreviewPaneAnimation'
import { BuildFooter } from './parts/BuildFooter'
import { TemplateYamlDrawer } from './parts/TemplateYamlDrawer'
import { CascadeForm } from './parts/CascadeForm'
import { CascadeHeading } from './parts/CascadeHeading'
import { ReviewPane } from './parts/ReviewPane'
import type { Selection } from '@/store'

interface BasicPageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
}

/**
 * The Basic tab: pick a vertical/SKU/platform/OS/kernel/image-type tuple, see the
 * resolved template summarised live in the right pane, dispatch a build.
 *
 * A container. Its own responsibilities are the two-pane layout, the auto-fill
 * loop, the preview-pane animation, and the dispatch action. Everything else is
 * delegated:
 *   - model/autofill      which dimension to fill next (pure, table-driven)
 *   - hooks/useLiveReview the debounced, abortable compose (carries a
 *                         load-bearing exhaustive-deps suppression)
 *   - parts/CascadeForm   the six dependent dropdowns
 *   - parts/ReviewPane    the resolved-template summary
 */
export function BasicPage({ onBuildStarted }: BasicPageProps) {
  const manifest = useStore((s) => s.manifest)
  const selection = useStore((s) => s.selection)
  const setField = useStore((s) => s.setField)

  const [yamlOpen, setYamlOpen] = useState(false)
  const yamlFullscreen = useYamlFullscreenActive()

  const opts = useMemo(
    () => (manifest ? cascadingOptions(manifest, selection) : null),
    [manifest, selection],
  )

  const complete = !!opts?.matched

  /*
   * Auto-fill single-option dropdowns.
   *
   * If a cascade dimension collapses to exactly one option, there's no real
   * choice for the user to make — expanding the dropdown to click the sole
   * entry is pure friction. `nextAutoFill` names the first dimension that
   * qualifies; setting it schedules a re-render, useMemo recomputes `opts`, and
   * this effect fires again for the next one. The chain terminates by itself.
   * See model/autofill.ts for the enabling rules and why they mirror each
   * <Select>'s `disabled`.
   *
   * Uses `setField` directly rather than the local `setSel` wrapper because
   * setSel clears any resolved review — auto-filling shouldn't yank a summary
   * the user might have been reading between one auto-set and the next. Fields
   * the USER changes still go through setSel.
   */
  useEffect(() => {
    if (!opts) return
    const next = nextAutoFill(selection, opts)
    if (next) setField(next.field, next.value)
  }, [opts, selection, setField])

  // Slides the review pane open/shut as the cascade completes. The one
  // non-obvious flag (snapWhenClose: false) is documented in the hook.
  const rightPanelRef = usePreviewPaneAnimation(complete)

  // The debounced compose that feeds the right pane. Its dep array lists the six
  // cascade fields individually and carries an exhaustive-deps suppression that
  // is load-bearing — see hooks/useLiveReview.
  const { review, reviewLoading, reviewError, clearReview } = useLiveReview({
    complete,
    manifest,
    selection,
  })


  // An incomplete cascade has no YAML to show, so never leave the drawer
  // stranded over an empty preview if the user edits a field via keyboard
  // while it's open.
  useEffect(() => {
    if (!complete) setYamlOpen(false)
  }, [complete])

  // The dispatch action. `busy` also gates the footer button against a
  // duplicate Jenkins job; see hooks/useDispatchBuild.
  const { busy, onBuild } = useDispatchBuild({
    complete,
    selection,
    onBuildStarted,
  })

  // Every hook above this line, unconditionally: the loading guard is an early
  // return, so a hook placed after it would be called conditionally and break
  // the Rules of Hooks. (FE-7c hit exactly that when useDispatchBuild replaced
  // the plain onBuild function, which was legitimately declared below.)
  if (!manifest || !opts) return <div className="p-8">Loading…</div>

  // Changing any field invalidates a prior review. Clearing it here (rather
  // than only in the effect) means the pane blanks the instant the user
  // edits, instead of showing a stale summary for the debounce window.
  const setSel = (k: keyof Selection, v: string) => {
    setField(k, v)
    clearReview()
  }

  /* Two-pane layout: form on the left, live YAML preview on the right.
   * PanelGroup carries the whole page height (minus the sticky header),
   * so the panels resize the full viewport and each pane scrolls
   * independently. */
  return (
    <div className="page-shell">
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel
          /* No fixed defaultSize on the left — the browser will fill it as
             (100 - rightPanelDefaultSize) so the two always sum to 100 %. */
          defaultSize={complete ? 55 : 100}
          minSize={35}
        >
          <div className="h-full overflow-y-auto p-6">
            <CascadeHeading />

            <CascadeForm selection={selection} opts={opts} setSel={setSel} />
          </div>
        </Panel>

        <PanelResizeHandle
          className="resize-handle group"
          /* When the preview is collapsed the handle would be a stray 8-px
             vertical strip against the right edge of the form — hide it. */
          style={{ display: complete ? 'block' : 'none' }}
        >
          <div className="resize-grip" aria-hidden />
        </PanelResizeHandle>

        <Panel
          ref={rightPanelRef}
          defaultSize={complete ? 45 : 0}
          minSize={0}
        >
          {/* Everything except the header row lives inside a fader so the
              content doesn't flash while the pane is still a sliver mid
              animation. */}
          {/* @container: reference box for the SummaryPanel key column's
           * `@max-pane-2col:w-20`. Safe as a stacking context / fixed
           * containing block — this pane renders summary tables only; the
           * YAML drawer (and the fullscreen-capable YamlEditor inside it)
           * mounts from DialogOverlay outside the PanelGroup. */}
          <div className="@container flex h-full flex-col p-6">
            <ReviewPane
              review={review}
              reviewLoading={reviewLoading}
              reviewError={reviewError}
              complete={complete}
              onOpenYaml={() => setYamlOpen(true)}
            />
          </div>
        </Panel>
      </PanelGroup>

      <BuildFooter complete={complete} busy={busy} onBuild={onBuild} />

      <TemplateYamlDrawer
        open={yamlOpen}
        onClose={() => setYamlOpen(false)}
        closeOnEscape={!yamlFullscreen}
        selection={selection}
        complete={complete}
      />
    </div>
  )
}
