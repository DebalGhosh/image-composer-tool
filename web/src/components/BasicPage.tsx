import { useMemo, useState } from 'react'
import { useStore, cascadingOptions, useToast } from '../store'
import { api } from '../api/client'
import type { ComposeResponse } from '../api/types'
import { Select } from './Select'
import { Card } from './Card'

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

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1
        className="mb-1 text-2xl font-bold"
        style={{ color: 'var(--title-text)' }}
      >
        Choose Image Configuration
      </h1>
      <p className="mb-5 text-sm text-[var(--muted-color)]">
        Select a targeted vertical, SKU, and platform. Pre-configured defaults are applied
        based on your selection.
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
        {/* Kernel selector appears only when the manifest offers kernel variants
            (e.g. standard vs real-time) for the current selection. */}
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
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
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
  )
}
