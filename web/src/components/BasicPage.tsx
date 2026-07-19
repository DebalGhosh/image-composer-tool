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

interface BasicPageProps {
  onBuildStarted: (buildId: string) => void
  buildInProgress: boolean
}

export function BasicPage({ onBuildStarted, buildInProgress }: BasicPageProps) {
  const manifest = useStore((s) => s.manifest)
  const selection = useStore((s) => s.selection)
  const setField = useStore((s) => s.setField)
  const toast = useToast()

  const [review, setReview] = useState<ComposeResponse | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const opts = useMemo(
    () => (manifest ? cascadingOptions(manifest, selection) : null),
    [manifest, selection],
  )

  const complete = !!opts?.matched

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

  if (!manifest || !opts) return <div className="p-8">Loading…</div>

  const onToggleReview = async () => {
    if (reviewOpen) {
      setReviewOpen(false)
      return
    }
    if (!complete) return
    try {
      setBusy(true)
      setReview(await api.compose(selection))
      setReviewOpen(true)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Review failed' })
    } finally {
      setBusy(false)
    }
  }

  const onBuild = async () => {
    if (!complete) return
    try {
      setBusy(true)
      const accepted = await api.startBuild(selection)
      onBuildStarted(accepted.buildId)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Build failed to start' })
    } finally {
      setBusy(false)
    }
  }

  // Changing any field invalidates a prior review.
  const setSel = (k: Parameters<typeof setField>[0], v: string) => {
    setField(k, v)
    setReviewOpen(false)
    setReview(null)
  }

  /* Two-pane layout: form on the left, live YAML preview on the right.
   * PanelGroup carries the whole page height (minus the sticky header),
   * so the panels resize the full viewport and each pane scrolls
   * independently. */
  return (
    <div className="basic-page-shell">
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

              <label
                className="mt-2 flex cursor-pointer items-center gap-3 text-sm"
                style={{ color: 'var(--font-color)' }}
              >
                <input
                  type="checkbox"
                  checked={reviewOpen}
                  disabled={!complete}
                  onChange={onToggleReview}
                  /* h-4 w-4 (~16px) bumps the native tick above the ~13px
                     default so the check itself gets more visual padding
                     inside the box. accent-color paints the tick in Intel
                     blue in browsers that support it (Chrome 93+, Firefox 92+,
                     Safari 15.4+). */
                  className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer disabled:cursor-not-allowed"
                />
                Review Image Configuration
              </label>
            </Card>

            {reviewOpen && review && (
              <Card title="Image Configuration Review" className="mt-5">
                <div className="mt-3 grid grid-cols-1 gap-3 text-sm xl:grid-cols-2">
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
              </Card>
            )}

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
          {/* Everything except the header row lives inside a fader that
              hides the editor while the panel is skinny (rendering a 480px
              CodeMirror inside a 6% strip looks terrible). Fade + slide as
              the pane drops in. */}
          <div className="flex h-full flex-col p-6">
            <h2
              className="mb-1 text-sm font-semibold uppercase tracking-wide whitespace-nowrap"
              style={{ color: 'var(--muted-color)' }}
            >
              Template Preview
            </h2>
            <p
              className="mb-4 text-xs whitespace-nowrap overflow-hidden text-ellipsis"
              style={{
                color: 'var(--muted-color)',
                opacity: complete ? 1 : 0.5,
                transition: 'opacity 260ms ease 120ms',
              }}
            >
              {complete
                ? 'Read-only. Updates as you change the selection on the left.'
                : 'Complete the form to preview'}
            </p>
            <div
              className="min-h-0 flex-1"
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
              <LiveYamlPreview selection={selection} complete={complete} />
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
            disabled={!complete || busy || buildInProgress}
            onClick={onBuild}
          >
            {busy ? 'Starting…' : buildInProgress ? 'Build in progress…' : 'Build Image'}
          </button>
          {!complete && !buildInProgress && (
            <span className="text-sm text-[var(--muted-color)]">
              Complete all selections to build.
            </span>
          )}
          {buildInProgress && (
            <span className="text-sm" style={{ color: 'var(--warning)' }}>
              A build is already in progress. Switch to the Build Image tab to monitor it.
            </span>
          )}
        </div>
      </footer>

      {/* Local styling: page shell fills the viewport minus header, and the
          drag handle gets a proper visual + hover state. */}
      <style>{`
        .basic-page-shell {
          height: calc(100vh - 3.75rem); /* nav ~60px; adjust if header height changes */
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .action-footer {
          flex: none;
          border-top: 1px solid var(--border-color);
          background: color-mix(in srgb, var(--section-background) 92%, transparent);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .resize-handle {
          position: relative;
          width: 8px;
          background: transparent;
          transition: background-color 160ms ease;
          cursor: col-resize;
        }
        .resize-handle:hover,
        .resize-handle[data-panel-resize-handle-active] {
          background: color-mix(in srgb, var(--classic-blue) 25%, transparent);
        }
        .resize-grip {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 2px;
          height: 40px;
          border-radius: 1px;
          background: var(--border-color);
          transition: background-color 160ms ease, height 160ms ease;
        }
        .resize-handle:hover .resize-grip,
        .resize-handle[data-panel-resize-handle-active] .resize-grip {
          background: var(--classic-blue);
          height: 60px;
        }
      `}</style>
    </div>
  )
}
