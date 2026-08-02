import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { useStore, cascadingOptions, useToast } from '../store'
import { api } from '../api/client'
import type { ComposeResponse } from '../api/types'
import { Select } from './Select'
import { Card } from './Card'
import { LiveYamlPreview } from './LiveYamlPreview'
import { SummaryPanel } from './SummaryPanel'
import { DialogOverlay } from './DialogOverlay'
import { useYamlFullscreenActive } from './YamlEditor'

interface BasicPageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
}

/**
 * Hamburger glyph for the template-YAML drawer trigger. Inline SVG with
 * `currentColor` per the existing icon convention in this codebase
 * (YamlEditor's ExpandIcon/CollapseIcon, Card's Chevron) — no icon
 * dependency.
 */
function MenuIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  )
}

export function BasicPage({ onBuildStarted }: BasicPageProps) {
  const manifest = useStore((s) => s.manifest)
  const selection = useStore((s) => s.selection)
  const setField = useStore((s) => s.setField)
  const toast = useToast()

  const [review, setReview] = useState<ComposeResponse | null>(null)
  // Separate from `busy` on purpose. `busy` gates the Build Image button;
  // the review now re-resolves on every cascade edit, and sharing the flag
  // would blink that button disabled on each keystroke.
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Whether the template-YAML drawer is open.
  const [yamlOpen, setYamlOpen] = useState(false)
  // True while a YamlEditor (the one inside the drawer) owns fullscreen —
  // used to hand Escape to it instead of closing the drawer out from under.
  const yamlFullscreen = useYamlFullscreenActive()

  // Latest selection, read at request-fire time inside the debounced
  // effect rather than captured in its closure.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

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
   * entry is pure friction. This effect walks the cascade top-down and sets
   * the first unset dimension that has a single option, one dimension per
   * render. Setting state schedules a re-render; useMemo recomputes `opts`
   * for the new selection; this effect fires again for the next dimension.
   * The chain terminates naturally the moment it hits a dimension that has
   * either 0 or 2+ options, or is already set.
   *
   * Enabling conditions mirror each <Select>'s `disabled` prop exactly, so
   * we never auto-fill a dimension that would still be greyed out to the
   * user (e.g. we don't set imageType before its kernel parent is picked
   * when there ARE kernel options to choose from).
   *
   * The auto-fill uses `setField` directly rather than the local `setSel`
   * wrapper because setSel closes any open review — auto-filling shouldn't
   * yank a review that the user might have opened between one auto-set and
   * the next. Fields the user changes still go through setSel and behave
   * exactly as before.
   */
  useEffect(() => {
    if (!opts) return
    if (opts.verticals.length === 1 && !selection.vertical) {
      setField('vertical', opts.verticals[0].id)
      return
    }
    if (selection.vertical && opts.skus.length === 1 && !selection.sku) {
      setField('sku', opts.skus[0].id)
      return
    }
    // Platform enables when sku is set OR when this vertical has no sku
    // dimension at all (opts.skus.length === 0).
    const skuGate = !!selection.sku || opts.skus.length === 0
    if (
      selection.vertical &&
      skuGate &&
      opts.platforms.length === 1 &&
      !selection.platform
    ) {
      setField('platform', opts.platforms[0].id)
      return
    }
    if (selection.platform && opts.oses.length === 1 && !selection.os) {
      setField('os', opts.oses[0].id)
      return
    }
    if (selection.os && opts.kernels.length === 1 && !selection.kernel) {
      setField('kernel', opts.kernels[0].id)
      return
    }
    // Image type enables when os is set AND (no kernel dimension OR kernel
    // is set). Matches the imageType <Select>'s `disabled` predicate.
    const kernelGate = opts.kernels.length === 0 || !!selection.kernel
    if (
      selection.os &&
      kernelGate &&
      opts.imageTypes.length === 1 &&
      !selection.imageType
    ) {
      setField('imageType', opts.imageTypes[0].id)
      return
    }
  }, [opts, selection, setField])

  /*
   * Preview-pane drop-in animation.
   *
   * The preview panel starts collapsed to a tiny strip (6%) and slides open
   * to a comfortable 45% when the cascade is complete — reversing when the
   * user un-picks a field. The animation is driven by requestAnimationFrame
   * imperatively via the panel's `resize(size)` handle because the
   * library doesn't animate size changes on its own.
   */
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null)
  const rafRef = useRef<number | null>(null)
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

    const handle = rightPanelRef.current
    if (!handle) return

    const from = handle.getSize()
    const to = complete ? 45 : 0
    if (Math.abs(from - to) < 0.5) return

    const duration = complete ? 520 : 380
    const start = performance.now()
    // easeOutCubic: fast start, gentle settle — matches the "drop-in" feel.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const size = from + (to - from) * ease(t)
      handle.resize(size)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }

    // Cancel any in-flight animation before starting a fresh one (fast
    // successive flips shouldn't fight each other).
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [complete])

  /*
   * Live review resolution.
   *
   * The review summary now lives in the right pane, which slides open on
   * its own the moment the cascade completes — there is no longer a
   * checkbox to (re-)trigger a fetch. So this resolves on EVERY complete
   * selection rather than latching once: debounced + abortable, mirroring
   * LiveYamlPreview.tsx:43-99 so the two panes stay in step and issue at
   * most one request each per settled selection.
   *
   * Placed BEFORE the loading early-return so hook order stays
   * unconditional across renders (Rules of Hooks).
   *
   * Errors render inline in the pane instead of raising a toast. Same
   * reasoning LiveYamlPreview documents at :76-81 — compose can fail on
   * any intermediate cascade state, and a toast per keystroke is noise.
   * The toast stays reserved for the dispatch path below.
   */
  useEffect(() => {
    if (!complete || !manifest) {
      setReview(null)
      setReviewError(null)
      setReviewLoading(false)
      return
    }

    // Flip the spinner on immediately rather than inside the timeout, so the
    // pane reads "Resolving…" for the debounce window instead of sitting
    // blank (setSel has just cleared the previous summary).
    setReviewLoading(true)
    setReviewError(null)

    // Declared out here so the cleanup below can abort a request this run
    // started. React always runs the previous effect's cleanup before the
    // next effect body, so that covers supersession AND unmount — no
    // separate module/ref bookkeeping needed.
    let ac: AbortController | null = null

    const t = setTimeout(async () => {
      ac = new AbortController()
      const signal = ac.signal
      try {
        // Read the selection at request-fire time rather than from this
        // closure, so a rapid cascade edit resolves the newest tuple.
        const r = await api.compose(selectionRef.current)
        if (signal.aborted) return
        setReview(r)
      } catch (e) {
        if (signal.aborted) return
        setReview(null)
        setReviewError((e as Error).message)
      } finally {
        // Left true when aborted: a newer run owns the flag and is already
        // resolving, so clearing it here would blink the spinner off.
        if (!signal.aborted) setReviewLoading(false)
      }
    }, 200) // Same 200ms beat as LiveYamlPreview.

    return () => {
      clearTimeout(t)
      ac?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    complete,
    manifest,
    selection.vertical,
    selection.sku,
    selection.platform,
    selection.os,
    selection.kernel,
    selection.imageType,
  ])

  // An incomplete cascade has no YAML to show, so never leave the drawer
  // stranded over an empty preview if the user edits a field via keyboard
  // while it's open.
  useEffect(() => {
    if (!complete) setYamlOpen(false)
  }, [complete])

  if (!manifest || !opts) return <div className="p-8">Loading…</div>

  const onBuild = async () => {
    if (!complete) return
    // Resolve the selection to a full template YAML (compose is a read-only
    // lookup), then fan the build out to a random idle worker in the Jenkins
    // farm. The dispatch endpoint returns a buildId keyed off the same
    // tracker as the local-build path, so the log stream + details panel
    // in BuildView work transparently.
    try {
      setBusy(true)
      const resolved = await api.compose(selection)
      const accepted = await api.dispatchJenkins(resolved.yaml)
      onBuildStarted(accepted.buildId, resolved.yaml)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Build failed to start' })
    } finally {
      setBusy(false)
    }
  }

  // Changing any field invalidates a prior review. Clearing it here (rather
  // than only in the effect) means the pane blanks the instant the user
  // edits, instead of showing a stale summary for the debounce window.
  const setSel = (k: Parameters<typeof setField>[0], v: string) => {
    setField(k, v)
    setReview(null)
    setReviewError(null)
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
            <h1
              className="mb-1 text-2xl font-bold"
              style={{ color: 'var(--title-text)' }}
            >
              Choose Image Configuration
            </h1>
            <p className="mb-5 text-sm text-[var(--muted-color)]">
              Select a targeted vertical, SKU, and platform. Pre-configured
              defaults are applied based on your selection.
            </p>

            <Card>
              <Select
                label="Targeted Vertical"
                placeholder="-- Select Vertical --"
                value={selection.vertical}
                options={opts.verticals}
                onChange={(v) => setSel('vertical', v)}
              />
              <Select
                label="SKU"
                placeholder="-- Select SKU --"
                value={selection.sku}
                options={opts.skus}
                disabled={!selection.vertical}
                onChange={(v) => setSel('sku', v)}
              />
              <Select
                label="Platform"
                placeholder="-- Select Platform --"
                value={selection.platform}
                options={opts.platforms}
                disabled={!selection.sku && opts.skus.length > 0}
                onChange={(v) => setSel('platform', v)}
              />
              <Select
                label="Operating System"
                placeholder="-- Select Operating System --"
                value={selection.os}
                options={opts.oses}
                disabled={!selection.platform}
                onChange={(v) => setSel('os', v)}
              />
              {/* Kernel selector appears only when the manifest offers kernel
                  variants (e.g. standard vs real-time) for the selection. */}
              {opts.kernels.length > 0 && (
                <Select
                  label="Kernel"
                  placeholder="-- Select Kernel --"
                  value={selection.kernel}
                  options={opts.kernels}
                  disabled={!selection.os}
                  onChange={(v) => setSel('kernel', v)}
                />
              )}
              <Select
                label="Image Type"
                placeholder="-- Select Image Type --"
                value={selection.imageType}
                options={opts.imageTypes}
                disabled={!selection.os || (opts.kernels.length > 0 && !selection.kernel)}
                onChange={(v) => setSel('imageType', v)}
              />
            </Card>
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
            {/* Bordered surface for the whole review section, matching the
                cascade dropdowns across the divider: same --input-background
                + --border-color + rounded-md recipe that Select.tsx's
                `controlBaseStyle` applies to every control in "Choose Image
                Configuration". The nested SummaryPanels paint themselves
                --page-background, which is darker than --input-background in
                the light theme and lighter in dark, so they stay legible as
                distinct tables against this container in both. */}
            <div
              className="flex min-h-0 flex-1 flex-col rounded-md border p-4"
              style={{
                background: 'var(--input-background)',
                borderColor: 'var(--border-color)',
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <h2
                  className="text-sm font-semibold uppercase tracking-wide whitespace-nowrap"
                  style={{ color: 'var(--muted-color)' }}
                >
                  Image Configuration Review
                </h2>
                {/* Hamburger → template-YAML drawer. Styled after
                    YamlEditor's fullscreen toggle (26×26, bordered, JS hover)
                    so the two YAML affordances feel related. */}
                <button
                  type="button"
                  onClick={() => setYamlOpen(true)}
                  disabled={!complete}
                  aria-label="View template YAML"
                  // haspopup="dialog", not aria-expanded: the drawer is a
                  // modal dialog, not a disclosure region this button owns.
                  aria-haspopup="dialog"
                  title="View template YAML"
                  style={{
                    flex: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 26,
                    height: 26,
                    borderRadius: 4,
                    border: '1px solid var(--border-color)',
                    background: 'var(--input-background)',
                    color: 'var(--muted-color)',
                    cursor: complete ? 'pointer' : 'not-allowed',
                    opacity: complete ? 1 : 0.5,
                    padding: 0,
                    lineHeight: 0,
                    transition: 'color 160ms ease, background-color 160ms ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!complete) return
                    e.currentTarget.style.color = 'var(--font-color)'
                    e.currentTarget.style.background =
                      'color-mix(in srgb, var(--classic-blue) 8%, var(--input-background))'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--muted-color)'
                    e.currentTarget.style.background = 'var(--input-background)'
                  }}
                >
                  <MenuIcon />
                </button>
              </div>
              <p
                className="mb-4 text-xs whitespace-nowrap overflow-hidden text-ellipsis"
                style={{
                  color: 'var(--muted-color)',
                  opacity: complete ? 1 : 0.5,
                  transition: 'opacity 260ms ease 120ms',
                }}
              >
                {complete
                  ? 'Resolved from your selection. ☰ opens the template YAML.'
                  : 'Complete the form to review'}
              </p>
              <div
                className="min-h-0 flex-1 overflow-y-auto"
                style={{
                  opacity: complete ? 1 : 0,
                  pointerEvents: complete ? 'auto' : 'none',
                  transition: 'opacity 320ms ease 120ms',
                }}
                /* Note: intentionally NOT using `transform: translateX(...)` here.
                   A permanent `transform` value on the style attribute establishes
                   a containing block for fixed-position descendants (CSS spec),
                   which would trap the YamlEditor's fullscreen overlay inside
                   this pane instead of covering the viewport. The 8px horizontal
                   slide was cosmetic; the pane's own width animation (0 → 45 %)
                   already carries most of the "drop-in" feel. */
              >
                {/* grid-cols-1 only, and deliberately no two-column variant at
                    the `xl` breakpoint — Tailwind breakpoints are
                    viewport-relative, so on a wide screen it would fire and
                    squeeze two summary tables into this 45%-wide pane.
                    (The `@max-pane-*` container variants elsewhere in the app
                    exist precisely to solve that; here one column is simply
                    the right answer at every width, so there's nothing to
                    make responsive — this pane holds a review summary, not a
                    form, and stacked panels read better than side-by-side.) */}
                {review && (
                  <div className="grid grid-cols-1 gap-3 text-sm">
                    <SummaryPanel
                      heading="Your Selection"
                      rows={
                        [
                          ['Vertical', review.summary.vertical],
                          review.summary.sku ? ['SKU', review.summary.sku] : null,
                          ['Platform', review.summary.platform],
                          ['OS', review.summary.os],
                          ['Image Type', review.summary.imageType.toUpperCase()],
                        ] as ([string, string] | null)[]
                      }
                    />
                    <SummaryPanel
                      heading="Image Configuration"
                      rows={
                        [
                          ['Image', `${review.summary.imageName}${review.summary.imageVersion ? ` (v${review.summary.imageVersion})` : ''}`],
                          review.summary.description ? ['Description', review.summary.description] : null,
                          ['Architecture', review.summary.architecture],
                          review.summary.kernelVersion ? ['Kernel', review.summary.kernelVersion] : null,
                          ['Packages', `${review.summary.packageCount} packages`],
                          review.summary.diskSize ? ['Disk', `${review.summary.diskSize}${review.summary.partitionTable ? `, ${review.summary.partitionTable.toUpperCase()}` : ''}${review.summary.partitionCount ? `, ${review.summary.partitionCount} partitions` : ''}`] : null,
                          review.summary.hostname ? ['Hostname', review.summary.hostname] : null,
                        ] as ([string, string] | null)[]
                      }
                    />
                  </div>
                )}
                {!review && reviewLoading && (
                  <p className="text-xs" style={{ color: 'var(--muted-color)' }}>
                    Resolving configuration…
                  </p>
                )}
                {!review && reviewError && (
                  <div
                    className="rounded-md border p-3 text-xs"
                    style={{
                      borderColor:
                        'color-mix(in srgb, var(--danger) 45%, var(--border-color))',
                      background:
                        'color-mix(in srgb, var(--danger) 6%, var(--section-background))',
                    }}
                  >
                    <p className="font-semibold" style={{ color: 'var(--danger)' }}>
                      Review unavailable
                    </p>
                    <p
                      className="mt-1 font-mono break-words"
                      style={{ color: 'var(--muted-color)' }}
                    >
                      {reviewError}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Sticky footer: the Build Image action stays anchored at the bottom
          of the viewport regardless of pane scroll position. Blurs the
          content behind it so the seam feels intentional in either theme. */}
      <footer className="action-footer">
        <div className="flex items-center gap-3 px-6 py-3">
          <button
            className="rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--metrics-gradient)' }}
            disabled={!complete || busy}
            onClick={onBuild}
          >
            {busy ? 'Starting…' : 'Build Image'}
          </button>
          {!complete && (
            <span className="text-sm text-[var(--muted-color)]">
              Complete all selections to build.
            </span>
          )}
        </div>
      </footer>

      {/*
       * Template-YAML drawer.
       *
       * LiveYamlPreview is handed through untouched — it is self-fetching
       * (200ms debounce + AbortController) and needs only these two props.
       * The drawer traps focus, so the selection can't change while it's
       * open and the preview resolves exactly once per open.
       *
       * `closeOnEscape` defers to the YamlEditor inside: both it and
       * DialogOverlay install document-level capture-phase Escape handlers
       * that stopPropagation, and DialogOverlay's is registered first
       * (on mount vs. on entering fullscreen). Without this, Escape while
       * fullscreen would tear down the whole drawer instead of just
       * leaving fullscreen.
       *
       * The drawer slides via `right`, never `transform` — see the
       * containing-block note on the pane above and in DialogOverlay's
       * header: a transform here would trap that same fullscreen overlay
       * inside the 720px panel.
       */}
      <DialogOverlay
        open={yamlOpen}
        onClose={() => setYamlOpen(false)}
        variant="drawer-right"
        closeOnEscape={!yamlFullscreen}
        title="Template Preview"
        ariaLabelledBy="basic-yaml-drawer-title"
      >
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <p className="mb-3 text-xs" style={{ color: 'var(--muted-color)' }}>
            Read-only. Resolved from the selection on the left.
          </p>
          <div className="min-h-0 flex-1">
            <LiveYamlPreview selection={selection} complete={complete} />
          </div>
        </div>
      </DialogOverlay>
    </div>
  )
}
