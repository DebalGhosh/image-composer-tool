import { useMemo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore, cascadingOptions, useToast } from '../store'
import { api } from '../api/client'
import type { ComposeResponse } from '../api/types'
import { Select } from './Select'
import { Card } from './Card'
import { LiveYamlPreview } from './LiveYamlPreview'

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

  if (!manifest || !opts) return <div className="p-8">Loading…</div>

  const complete = !!opts.matched

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
      <PanelGroup direction="horizontal" className="h-full" autoSaveId="basic-split">
        <Panel defaultSize={55} minSize={35}>
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
                className="mt-1 flex cursor-pointer items-center gap-2 text-sm"
                style={{ color: 'var(--font-color)' }}
              >
                <input
                  type="checkbox"
                  checked={reviewOpen}
                  disabled={!complete}
                  onChange={onToggleReview}
                  className="accent-[var(--classic-blue)]"
                />
                Review Image Configuration
              </label>
            </Card>

            {reviewOpen && review && (
              <Card title="Image Configuration Review" className="mt-5">
                <div className="mt-3 grid grid-cols-1 gap-3 text-xs xl:grid-cols-2">
                  <div className="rounded p-3" style={{ background: 'var(--page-background)' }}>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-color)' }}>Your Selection</p>
                    <table className="w-full">
                      <tbody>
                        {([
                          ['Vertical', review.summary.vertical],
                          review.summary.sku ? ['SKU', review.summary.sku] : null,
                          ['Platform', review.summary.platform],
                          ['OS', review.summary.os],
                          ['Image Type', review.summary.imageType.toUpperCase()],
                        ] as ([string, string] | null)[]).filter((r): r is [string, string] => r !== null).map(([k, v]) => (
                          <tr key={k}>
                            <td className="py-0.5 pr-3 w-24 font-semibold" style={{ color: 'var(--muted-color)' }}>{k}</td>
                            <td className="py-0.5" style={{ color: 'var(--font-color)' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="rounded p-3" style={{ background: 'var(--page-background)' }}>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-color)' }}>Image Configuration</p>
                    <table className="w-full">
                      <tbody>
                        {([
                          ['Image', `${review.summary.imageName}${review.summary.imageVersion ? ` (v${review.summary.imageVersion})` : ''}`],
                          review.summary.description ? ['Description', review.summary.description] : null,
                          ['Architecture', review.summary.architecture],
                          review.summary.kernelVersion ? ['Kernel', review.summary.kernelVersion] : null,
                          ['Packages', `${review.summary.packageCount} packages`],
                          review.summary.diskSize ? ['Disk', `${review.summary.diskSize}${review.summary.partitionTable ? `, ${review.summary.partitionTable.toUpperCase()}` : ''}${review.summary.partitionCount ? `, ${review.summary.partitionCount} partitions` : ''}`] : null,
                          review.summary.hostname ? ['Hostname', review.summary.hostname] : null,
                        ] as ([string, string] | null)[]).filter((r): r is [string, string] => r !== null).map(([k, v]) => (
                          <tr key={k}>
                            <td className="py-0.5 pr-3 w-24 font-semibold" style={{ color: 'var(--muted-color)' }}>{k}</td>
                            <td className="py-0.5" style={{ color: 'var(--font-color)' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Card>
            )}

            <div className="mt-6">
              <button
                className="rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: 'var(--metrics-gradient)' }}
                disabled={!complete || busy || buildInProgress}
                onClick={onBuild}
              >
                {busy ? 'Starting…' : buildInProgress ? 'Build in progress…' : 'Build Image'}
              </button>
              {!complete && !buildInProgress && (
                <span className="ml-3 text-sm text-[var(--muted-color)]">
                  Complete all selections to build.
                </span>
              )}
              {buildInProgress && (
                <span className="ml-3 text-sm" style={{ color: 'var(--warning)' }}>
                  A build is already in progress. Switch to the Build Image tab to monitor it.
                </span>
              )}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle group">
          <div className="resize-grip" aria-hidden />
        </PanelResizeHandle>

        <Panel defaultSize={45} minSize={25}>
          <div className="flex h-full flex-col p-6">
            <h2
              className="mb-1 text-sm font-semibold uppercase tracking-wide"
              style={{ color: 'var(--muted-color)' }}
            >
              Template Preview
            </h2>
            <p className="mb-4 text-xs" style={{ color: 'var(--muted-color)' }}>
              Read-only. Updates as you change the selection on the left.
            </p>
            <div className="min-h-0 flex-1">
              <LiveYamlPreview selection={selection} complete={complete} />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Local styling: page shell fills the viewport minus header, and the
          drag handle gets a proper visual + hover state. */}
      <style>{`
        .basic-page-shell {
          height: calc(100vh - 3.75rem); /* nav ~60px; adjust if header height changes */
          min-height: 0;
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
