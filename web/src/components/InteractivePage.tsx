// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

/*
 * InteractivePage — form-driven CoreV1 template composer.
 *
 * Round-trip model:
 *   Seed (compose?form=merged)  →  parseYamlToDraft  →  InteractiveDraft
 *                                       (edit)
 *                                        ▼
 *   applyOverrides(draft) → YAML  →  api.dispatchJenkins → Build
 *
 * The draft lives in the shared store so tab-switches don't discard edits.
 * The right pane renders a live YAML preview that re-serializes on every
 * change. The Build button posts the memoed YAML straight to Jenkins.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { useStore, useToast, type InteractiveDraft, type UserConfig } from '../store'
import { api } from '../api/client'
import type { ComposeRequest } from '../api/types'
import { Card } from './Card'
import { Collapsible } from './Collapsible'
import { Combobox, type ComboboxItem } from './Combobox'
import {
  MultiCombobox,
  type MultiComboboxOption,
} from './MultiCombobox'
import {
  NativeSelect,
  TextInput,
  TextArea,
  fieldLabelClass,
  fieldLabelStyle,
} from './Select'
import { Slider } from './Slider'
import {
  SegmentedPartitionEditor,
  type Arch,
  type Partition,
} from './SegmentedPartitionEditor'
import { PackageSearchCombobox } from './PackageSearchCombobox'
import { InteractiveYamlPreview } from './InteractiveYamlPreview'
import { applyOverrides, parseYamlToDraft } from '../lib/draftFromYaml'

interface InteractivePageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
}

/* ------------------------------------------------------------------------- *
 * Static option tables — kept top-level so they don't reallocate per render.
 * ------------------------------------------------------------------------- */

const OS_OPTIONS: ComboboxItem[] = [
  { value: 'ubuntu', label: 'Ubuntu' },
  { value: 'debian', label: 'Debian' },
  { value: 'azure-linux', label: 'Azure Linux' },
  { value: 'edge-microvisor-toolkit', label: 'Edge Microvisor Toolkit' },
  { value: 'wind-river-elxr', label: 'Wind River eLxr' },
  { value: 'redhat-compatible-distro', label: 'Red Hat Compatible' },
]

/** OS → allowed distributions. Gates the dist Combobox. */
const DIST_BY_OS: Record<string, ComboboxItem[]> = {
  ubuntu: [
    { value: 'ubuntu24', label: 'ubuntu24' },
    { value: 'ubuntu26', label: 'ubuntu26' },
  ],
  debian: [{ value: 'debian13', label: 'debian13' }],
  'azure-linux': [{ value: 'azl3', label: 'azl3' }],
  'edge-microvisor-toolkit': [{ value: 'emt3', label: 'emt3' }],
  'wind-river-elxr': [
    { value: 'elxr12', label: 'elxr12' },
    { value: 'elxr13', label: 'elxr13' },
  ],
  'redhat-compatible-distro': [{ value: 'rcd10', label: 'rcd10' }],
}

const ARCH_OPTIONS: { value: Arch; label: string }[] = [
  { value: 'x86_64', label: 'x86_64' },
  { value: 'aarch64', label: 'aarch64' },
  { value: 'armv7hl', label: 'armv7hl' },
]

const IMAGE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'raw', label: 'raw' },
  { value: 'img', label: 'img' },
  { value: 'iso', label: 'iso' },
  { value: 'wsl2', label: 'wsl2' },
]

/** Per-dist kernel version presets. Empty list ⇒ nothing to suggest. */
const KERNEL_VERSIONS_BY_DIST: Record<string, string[]> = {
  ubuntu24: ['6.8', '6.11', '6.12', '7.0'],
  debian13: ['6.12'],
  azl3: ['6.6'],
  emt3: ['6.12'],
  elxr12: ['6.1', '6.12'],
  rcd10: ['6.12'],
}

/** Per-dist kernel package presets. Empty list ⇒ empty MultiCombobox. */
const KERNEL_PACKAGES_BY_DIST: Record<string, string[]> = {
  ubuntu24: [
    'linux-image-generic',
    'linux-headers-generic',
    'linux-image-generic-hwe-24.04',
    'linux-image-6.12-intel',
    'linux-headers-6.12-intel',
  ],
  debian13: ['linux-image-amd64', 'linux-image-arm64'],
}

/** Image-name pattern per CoreV1 spec: alnum + [-_], must start/end alnum. */
const IMAGE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-_]*[a-zA-Z0-9])?$/

/* ------------------------------------------------------------------------- *
 * InteractivePage
 * ------------------------------------------------------------------------- */

export function InteractivePage({ onBuildStarted }: InteractivePageProps) {
  const manifest = useStore((s) => s.manifest)
  const storeDraft = useStore((s) => s.interactiveDraft)
  const setDraft = useStore((s) => s.setInteractiveDraft)
  const loadDraft = useStore((s) => s.loadInteractiveDraft)
  const seedPick = useStore((s) => s.interactiveSeedPick)
  const setSeedPick = useStore((s) => s.setInteractiveSeedPick)
  const toast = useToast()

  // Materialize a display draft so the form is always populated even before
  // the first edit. Writes still go through setDraft which promotes storeDraft
  // from null on the first onChange.
  const draft: InteractiveDraft = useMemo(
    () => storeDraft ?? emptyDisplayDraft,
    [storeDraft],
  )

  const [seedBusy, setSeedBusy] = useState(false)
  const [busy, setBusy] = useState(false)

  /* -------------------- Derived: completeness + live YAML -------------------- */

  const complete =
    storeDraft !== null &&
    draft.target.os.length > 0 &&
    draft.target.dist.length > 0 &&
    draft.target.arch.length > 0 &&
    draft.target.imageType.length > 0 &&
    draft.disk.sizeGiB > 0

  // memoedYaml + error status. applyOverrides is pure — a throw here only
  // means the draft shape is somehow inconsistent (e.g. corrupt baseDoc), so
  // we surface it in the preview instead of crashing the tab.
  const { yaml: memoedYaml, error: yamlError } = useMemo(() => {
    if (!storeDraft) return { yaml: '', error: null as string | null }
    try {
      return { yaml: applyOverrides(storeDraft), error: null as string | null }
    } catch (e) {
      return { yaml: '', error: (e as Error).message }
    }
  }, [storeDraft])

  const previewStatus: 'empty' | 'ready' | 'error' =
    storeDraft === null
      ? 'empty'
      : yamlError
        ? 'error'
        : memoedYaml.length > 0
          ? 'ready'
          : 'empty'

  /* -------------------- RAF right-pane animation ---------------------------- */
  // TODO(v2): dedupe with BasicPage. Copied verbatim from BasicPage.tsx:48-95
  // so the two tabs feel identical when the preview drops in / out.
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null)
  const rafRef = useRef<number | null>(null)
  const prevCompleteRef = useRef<boolean | null>(null)

  /* -------------------- User-driven collapse of the preview pane ---------- *
   * Independent of `complete`. When the user clicks the toggle chevron on
   * the divider, we animate the panel to 0% width and remember the size
   * they were on so re-expand goes back to the same width. If they never
   * dragged, the fallback is 45% — the same as the auto-open size.
   */
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
  const lastExpandedSizeRef = useRef<number>(45)

  const animatePanel = useCallback((toPercent: number, ms: number) => {
    const handle = rightPanelRef.current
    if (!handle) return
    const from = handle.getSize()
    if (Math.abs(from - toPercent) < 0.5) {
      handle.resize(toPercent)
      return
    }
    const start = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const size = from + (toPercent - from) * ease(t)
      handle.resize(size)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
  }, [])

  const togglePreview = useCallback(() => {
    const handle = rightPanelRef.current
    if (!handle) return
    if (previewCollapsed) {
      // Expand back to the user's last-remembered width.
      setPreviewCollapsed(false)
      animatePanel(lastExpandedSizeRef.current, 420)
    } else {
      // Remember the current width so re-expand lands where they left it.
      const current = handle.getSize()
      if (current > 5) lastExpandedSizeRef.current = current
      setPreviewCollapsed(true)
      animatePanel(0, 320)
    }
  }, [previewCollapsed, animatePanel])

  // Live-tracked right panel size (as % of the PanelGroup width). Used to
  // pin the toggle button to the boundary between the two panels — the
  // button lives outside the panels so it can float over the resize
  // handle when the preview is expanded and hug the viewport edge when
  // the preview is collapsed (right size = 0).
  const [rightSizePct, setRightSizePct] = useState<number>(complete ? 45 : 0)

  useEffect(() => {
    if (prevCompleteRef.current === null) {
      prevCompleteRef.current = complete
      return
    }
    if (prevCompleteRef.current === complete) return
    prevCompleteRef.current = complete

    const handle = rightPanelRef.current
    if (!handle) return

    // If the user has manually collapsed the preview, don't yank it
    // back open when `complete` flips true again (e.g. after switching
    // seeds). Keep it collapsed until they click the toggle themselves.
    if (previewCollapsed) return

    const from = handle.getSize()
    const to = complete ? 45 : 0
    if (Math.abs(from - to) < 0.5) return

    const duration = complete ? 520 : 380
    const start = performance.now()
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

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [complete, previewCollapsed])

  /* -------------------- Nested-field patch helpers -------------------------- */
  // setInteractiveDraft only shallow-merges. Nested slices (target, disk,
  // kernel, user) must be rebuilt explicitly per patch.

  const patchTarget = useCallback(
    (p: Partial<InteractiveDraft['target']>) =>
      setDraft({ target: { ...draft.target, ...p } }),
    [draft.target, setDraft],
  )
  const patchDisk = useCallback(
    (p: Partial<InteractiveDraft['disk']>) =>
      setDraft({ disk: { ...draft.disk, ...p } }),
    [draft.disk, setDraft],
  )
  const patchKernel = useCallback(
    (p: Partial<InteractiveDraft['kernel']>) =>
      setDraft({ kernel: { ...draft.kernel, ...p } }),
    [draft.kernel, setDraft],
  )
  const patchUser = useCallback(
    (u: UserConfig | null) => setDraft({ user: u }),
    [setDraft],
  )

  /* -------------------- Seed loading ---------------------------------------- */

  const seedLabel = useCallback(
    (i: number): string => {
      if (!manifest) return `Seed ${i}`
      const c = manifest.combinations[i]
      if (!c) return `Seed ${i}`
      const v = manifest.verticals.find((o) => o.id === c.vertical)?.displayName ?? c.vertical
      const sku = c.sku
        ? manifest.skus.find((o) => o.id === c.sku)?.displayName ?? c.sku
        : ''
      const p = manifest.platforms.find((o) => o.id === c.platform)?.displayName ?? c.platform
      const os = manifest.targets.find((o) => o.id === c.os)?.displayName ?? c.os
      const rt = c.kernel === 'rt' ? 'RT' : ''
      return [v, sku, p, os, rt, c.imageType.toUpperCase()].filter(Boolean).join(' · ')
    },
    [manifest],
  )

  const hasNonTrivialEdits = (d: InteractiveDraft | null): boolean => {
    if (!d) return false
    return (
      d.imageName.length > 0 ||
      d.hostname.length > 0 ||
      d.packages.length > 0 ||
      d.disk.partitions.length > 0
    )
  }

  const loadSeed = useCallback(
    async (idx: number) => {
      if (!manifest) return
      const combo = manifest.combinations[idx]
      if (!combo) return
      const req: ComposeRequest = {
        vertical: combo.vertical,
        sku: combo.sku,
        platform: combo.platform,
        os: combo.os,
        kernel: combo.kernel,
        imageType: combo.imageType,
      }
      try {
        setSeedBusy(true)
        const resp = await api.composeMerged(req)
        const parsed = parseYamlToDraft(resp.yaml)
        loadDraft(parsed)
        setSeedPick(String(idx))
      } catch (e) {
        toast.danger((e as Error).message, {
          title: 'Failed to load seed template',
        })
      } finally {
        setSeedBusy(false)
      }
    },
    [manifest, loadDraft, setSeedPick, toast],
  )

  const onSeedChange = async (raw: string) => {
    if (!raw) {
      setSeedPick('')
      return
    }
    if (hasNonTrivialEdits(storeDraft)) {
      if (!window.confirm('Replace the current draft with the seed template?')) return
    }
    // Mirror the Advanced tab: pin the dropdown selection synchronously so
    // it reflects the pick during the async compose+parse round-trip. Without
    // this the <select> would stay on the empty placeholder until the fetch
    // resolved (~100-300ms feels like the click didn't register), or would
    // revert to empty forever if compose threw.
    setSeedPick(raw)
    await loadSeed(Number(raw))
  }

  const onReloadSeed = async () => {
    if (!seedPick) return
    if (hasNonTrivialEdits(storeDraft)) {
      if (!window.confirm('Reload seed and discard local edits?')) return
    }
    await loadSeed(Number(seedPick))
  }

  /* -------------------- Build action --------------------------------------- */

  const onBuild = async () => {
    if (!complete || busy) return
    if (!memoedYaml) {
      toast.danger('Preview YAML is empty — cannot build.', {
        title: 'Build failed to start',
      })
      return
    }
    try {
      setBusy(true)
      const accepted = await api.dispatchJenkins(memoedYaml)
      onBuildStarted(accepted.buildId, memoedYaml)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Build failed to start' })
    } finally {
      setBusy(false)
    }
  }

  // Kernel-version items include the current value if the seed dropped an
  // otherwise-unknown version in — otherwise the Combobox would show the
  // placeholder and the operator would think it had been wiped.
  // NOTE: memos live above the `if (!manifest)` early return so hook order
  // stays stable across the initial manifest-loading render and the first
  // hydrated render.
  const kernelVersionItems: ComboboxItem[] = useMemo(() => {
    const presets = KERNEL_VERSIONS_BY_DIST[draft.target.dist] ?? []
    const items: ComboboxItem[] = presets.map((v) => ({ value: v, label: v }))
    const cur = draft.kernel.version
    if (cur && !presets.includes(cur)) {
      items.push({ value: cur, label: `${cur} (from seed)` })
    }
    return items
  }, [draft.target.dist, draft.kernel.version])

  const kernelPackageOptions: MultiComboboxOption[] = useMemo(() => {
    const base = KERNEL_PACKAGES_BY_DIST[draft.target.dist] ?? []
    return base.map((p) => ({ value: p, label: p }))
  }, [draft.target.dist])

  if (!manifest) return <div className="p-8">Loading…</div>

  /* -------------------- Render -------------------------------------------- */

  const distItems = DIST_BY_OS[draft.target.os] ?? []

  const showInherited =
    draft.inheritedConfigurations.length > 0 ||
    draft.inheritedRepositories.length > 0

  const imageNameInvalid =
    draft.imageName.length > 0 && !IMAGE_NAME_RE.test(draft.imageName)

  return (
    <div className="interactive-page-shell">
      {/*
       * Wrap the PanelGroup in a `relative` container so we can absolutely
       * position the collapse-preview chevron button over the resize
       * handle at the panel boundary. The button reads `rightSizePct`
       * (updated live via <Panel onResize>) so its right offset tracks
       * whatever width the user has dragged the right pane to; when the
       * pane is collapsed to 0%, the button hugs the viewport's right
       * edge.
       */}
      <div className="relative min-h-0 flex-1">
      <PanelGroup direction="horizontal" className="h-full">
        <Panel defaultSize={complete ? 55 : 100} minSize={35}>
          {/*
           * Top padding lives on the inner content, NOT on the scroll
           * container. If it were on the scroller, scrolled content
           * would slide underneath the padding strip (browsers don't
           * treat overflow-container padding as opaque), showing a
           * bleed-through gap above the sticky accordion header. With
           * padding on the inner div, the scrollable content ends at
           * the container's true top edge and sticky headers pin
           * flush against the pane's visible top.
           */}
          <div className="h-full overflow-y-auto">
            <div className="px-6 pt-6 pb-6">
            <h1
              className="mb-1 text-2xl font-bold"
              style={{ color: 'var(--title-text)' }}
            >
              Interactive Template Builder
            </h1>
            <p className="mb-5 text-sm text-[var(--muted-color)]">
              Pick a seed to prefill, then tune the target, disk, kernel, and
              packages. The preview on the right re-serializes as you edit.
            </p>

            {/* 1. Seed
             *
             * Show the current pick right in the accordion header (as an
             * inline muted label after the "SEED FROM TEMPLATE" heading) so
             * users see what's loaded without expanding the card, matching
             * the Advanced tab's always-visible affordance. Reload lives in
             * the header's `actions` slot for the same reason — clicks stop
             * bubbling to the header toggle inside the Card component.
             */}
            <Card
              titleStyle="section"
              collapsible
              className="mb-4"
              title={
                // Wrapped in min-w-0 so the truncate on the seed-label span
                // can actually clip when the accordion header is narrow.
                // Otherwise the h2's whitespace-nowrap would let the whole
                // heading overflow the card horizontally.
                <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">
                  <span className="shrink-0">Seed from template</span>
                  {seedPick && !seedBusy && (
                    <span
                      className="min-w-0 truncate font-mono text-[11px] font-normal normal-case tracking-normal opacity-70"
                      style={{ color: 'var(--muted-color)' }}
                    >
                      · {seedLabel(Number(seedPick))}
                    </span>
                  )}
                  {seedBusy && (
                    <span
                      className="text-[11px] font-normal normal-case tracking-normal opacity-70"
                      style={{ color: 'var(--muted-color)' }}
                    >
                      · Loading seed…
                    </span>
                  )}
                </span>
              }
              actions={
                <button
                  type="button"
                  onClick={onReloadSeed}
                  disabled={!seedPick || seedBusy || busy}
                  className="cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
                  style={{
                    borderColor: 'var(--border-color)',
                    color: 'var(--font-color)',
                  }}
                  title={
                    seedPick
                      ? 'Discard local edits and reload the selected seed'
                      : 'Pick a seed first'
                  }
                  aria-label="Reload seed template"
                >
                  ↻ Reload
                </button>
              }
            >
              <NativeSelect
                id="interactive-seed"
                value={seedPick}
                disabled={seedBusy || busy}
                onChange={(e) => onSeedChange(e.target.value)}
                containerClassName="min-w-0"
              >
                <option value="">
                  {seedBusy ? 'Loading seed…' : '-- Pick a template to prefill --'}
                </option>
                {manifest.combinations.map((c, i) => (
                  <option key={`${c.template}-${i}`} value={String(i)}>
                    {seedLabel(i)}
                  </option>
                ))}
              </NativeSelect>
              {seedPick && !seedBusy && (
                <p className="mt-2 text-xs" style={{ color: 'var(--muted-color)' }}>
                  Loaded from{' '}
                  <span className="font-mono" style={{ color: 'var(--font-color)' }}>
                    {seedLabel(Number(seedPick))}
                  </span>
                  . Edit freely — click Reload to reset from the seed.
                </p>
              )}
            </Card>

            {/* 2. Image */}
            <Card
              title="Image"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="mb-4">
                <label
                  htmlFor="i-image-name"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Image name
                </label>
                <TextInput
                  id="i-image-name"
                  value={draft.imageName}
                  onChange={(e) => setDraft({ imageName: e.target.value })}
                  placeholder="my-image"
                  aria-invalid={imageNameInvalid || undefined}
                  style={
                    imageNameInvalid
                      ? { borderColor: 'var(--danger)' }
                      : undefined
                  }
                />
                {imageNameInvalid && (
                  <p className="mt-1 text-xs" style={{ color: 'var(--danger-fg)' }}>
                    Must be alphanumeric with <code>-</code> or <code>_</code>{' '}
                    between; must start and end with an alnum character.
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="i-image-version"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Image version
                </label>
                <TextInput
                  id="i-image-version"
                  value={draft.imageVersion}
                  onChange={(e) => setDraft({ imageVersion: e.target.value })}
                  placeholder="1.0.0"
                />
              </div>
            </Card>

            {/* 3. Target
             *
             * Layout: two symmetric 2-column rows, each grouping a pair of
             * semantically-related fields at matching visual weights.
             *
             *   Row 1 — Family:   OS  |  Distribution     (both dropdowns)
             *                                 – OS gates Distribution
             *
             *   Row 2 — Format:   Architecture | Image type   (both segmented)
             *                                 – both pill selectors
             *
             * Previously Architecture and Image type each took a full-width
             * row, so the card read as "2 dropdowns then 2 stacked bars" —
             * mismatched vertical rhythm and wasted horizontal space on wide
             * viewports. The paired grouping now gives the card a stable
             * 2×2 shape while keeping the semantic gate (OS → Dist)
             * visible in one row and the format pickers in the next.
             *
             * A subtle divider between the rows reinforces the family/format
             * split without adding a heading.
             */}
            <Card
              title="Target"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              {/* Row 1: OS + Distribution — dropdowns, gated cascade */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label
                    id="i-os-label"
                    className={fieldLabelClass}
                    style={fieldLabelStyle}
                  >
                    OS
                  </label>
                  <Combobox
                    ariaLabelledBy="i-os-label"
                    value={draft.target.os}
                    items={OS_OPTIONS}
                    placeholder="-- Select OS --"
                    onChange={(v) => {
                      // Reset dist if the new OS doesn't offer the current dist.
                      const allowed = DIST_BY_OS[v] ?? []
                      const nextDist = allowed.some((d) => d.value === draft.target.dist)
                        ? draft.target.dist
                        : allowed[0]?.value ?? ''
                      patchTarget({ os: v, dist: nextDist })
                    }}
                  />
                </div>
                <div>
                  <label
                    id="i-dist-label"
                    className={fieldLabelClass}
                    style={fieldLabelStyle}
                  >
                    Distribution
                  </label>
                  <Combobox
                    ariaLabelledBy="i-dist-label"
                    value={draft.target.dist}
                    items={distItems}
                    placeholder={
                      distItems.length === 0
                        ? '-- Pick an OS first --'
                        : '-- Select distribution --'
                    }
                    disabled={distItems.length === 0}
                    onChange={(v) => patchTarget({ dist: v })}
                  />
                </div>
              </div>

              {/* Divider marks the split between "which system" (row 1)
               *  and "how the image is built" (row 2). Half-transparent
               *  border so it stays discreet inside the card. */}
              <div
                className="my-4 h-px"
                style={{
                  background:
                    'color-mix(in srgb, var(--border-color) 55%, transparent)',
                }}
              />

              {/* Row 2: Architecture + Image type — segmented pills, same
               *  visual weight, side-by-side for balance. Each Segmented
               *  wraps internally on narrow columns so no chip clips. */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Segmented
                  label="Architecture"
                  value={draft.target.arch}
                  options={ARCH_OPTIONS}
                  onChange={(v) => patchTarget({ arch: v })}
                />
                <Segmented
                  label="Image type"
                  value={draft.target.imageType}
                  options={IMAGE_TYPE_OPTIONS}
                  onChange={(v) => patchTarget({ imageType: v })}
                />
              </div>
            </Card>

            {/* 4. Disk & partitions */}
            <Card
              title="Disk & partitions"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <Slider
                label="Total disk size"
                value={draft.disk.sizeGiB}
                onChange={(v) => patchDisk({ sizeGiB: v })}
                min={2}
                max={256}
                step={1}
                unit="GiB"
              />
              <div className="mb-4">
                <span className={fieldLabelClass} style={fieldLabelStyle}>
                  Partition table
                </span>
                <div role="radiogroup" className="flex gap-4 text-sm">
                  {(['gpt', 'mbr'] as const).map((t) => (
                    <label
                      key={t}
                      className="inline-flex cursor-pointer items-center gap-2"
                    >
                      <input
                        type="radio"
                        name="partition-table"
                        checked={draft.disk.partitionTableType === t}
                        onChange={() => patchDisk({ partitionTableType: t })}
                        className="h-4 w-4 accent-[var(--classic-blue)]"
                      />
                      <span style={{ color: 'var(--font-color)' }}>
                        {t.toUpperCase()}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <SegmentedPartitionEditor
                value={draft.disk.partitions as Partition[]}
                diskSizeGiB={draft.disk.sizeGiB}
                arch={draft.target.arch as Arch}
                partitionTableType={draft.disk.partitionTableType}
                onChange={(parts) => patchDisk({ partitions: parts })}
              />
            </Card>

            {/* 5. Kernel */}
            <Card
              title="Kernel"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="mb-4">
                <label
                  id="i-kernel-version-label"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Kernel version
                </label>
                <Combobox
                  ariaLabelledBy="i-kernel-version-label"
                  value={draft.kernel.version}
                  items={kernelVersionItems}
                  placeholder={
                    kernelVersionItems.length === 0
                      ? '(no presets — inherit from seed)'
                      : '-- Select kernel version --'
                  }
                  disabled={kernelVersionItems.length === 0}
                  onChange={(v) => patchKernel({ version: v })}
                />
              </div>
              <div className="mb-4">
                <label
                  htmlFor="i-kernel-cmdline"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Command-line
                </label>
                <TextArea
                  id="i-kernel-cmdline"
                  value={draft.kernel.cmdline}
                  onChange={(e) => patchKernel({ cmdline: e.target.value })}
                  placeholder="console=ttyS0,115200 …"
                />
              </div>
              <div className="mb-4">
                <label
                  id="i-kernel-packages-label"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Kernel packages
                </label>
                <MultiCombobox
                  ariaLabelledBy="i-kernel-packages-label"
                  values={draft.kernel.packages}
                  options={kernelPackageOptions}
                  placeholder={
                    kernelPackageOptions.length === 0
                      ? '(no presets — inherit from seed)'
                      : 'Select kernel packages…'
                  }
                  disabled={kernelPackageOptions.length === 0}
                  onChange={(next) => patchKernel({ packages: next })}
                />
              </div>
              <div className="mb-4">
                <label
                  htmlFor="i-kernel-extra"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Enable extra modules
                </label>
                <TextInput
                  id="i-kernel-extra"
                  value={draft.kernel.enableExtraModules}
                  onChange={(e) =>
                    patchKernel({ enableExtraModules: e.target.value })
                  }
                  placeholder="e.g. i915 nvme (space-separated)"
                />
              </div>
              <label
                className="flex cursor-pointer items-center gap-3 text-sm"
                style={{ color: 'var(--font-color)' }}
              >
                <input
                  type="checkbox"
                  checked={draft.kernel.uki}
                  onChange={(e) => patchKernel({ uki: e.target.checked })}
                  className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
                />
                Build Unified Kernel Image (UKI)
              </label>
            </Card>

            {/* 6. Packages */}
            <Card
              title="Packages"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <PackageSearchCombobox
                values={draft.packages}
                onChange={(next) => setDraft({ packages: next })}
                os={draft.target.dist}
                arch={draft.target.arch}
              />
              <p className="mt-2 text-xs" style={{ color: 'var(--muted-color)' }}>
                {draft.packages.length} package(s) selected
              </p>
            </Card>

            {/* 7. System */}
            <Card
              title="System"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="mb-4">
                <label
                  htmlFor="i-hostname"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Hostname
                </label>
                <TextInput
                  id="i-hostname"
                  value={draft.hostname}
                  onChange={(e) => setDraft({ hostname: e.target.value })}
                  placeholder="my-host"
                />
              </div>
              <UserBlock
                user={draft.user}
                onChange={patchUser}
              />
            </Card>

            {/* 8. Inherited */}
            {showInherited && (
              <Card
                title="Inherited from seed"
                titleStyle="section"
                collapsible
                defaultCollapsed
                className="mb-4"
              >
                <p
                  className="text-xs"
                  style={{ color: 'var(--muted-color)' }}
                >
                  {draft.inheritedConfigurations.length} shell step
                  {draft.inheritedConfigurations.length === 1 ? '' : 's'}{' '}
                  inherited from seed — edit in Advanced.
                </p>
                <p
                  className="mt-1 text-xs"
                  style={{ color: 'var(--muted-color)' }}
                >
                  {draft.inheritedRepositories.length} package repositor
                  {draft.inheritedRepositories.length === 1 ? 'y' : 'ies'}{' '}
                  inherited from seed — edit in Advanced.
                </p>
              </Card>
            )}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle
          className="resize-handle group"
          style={{ display: complete ? 'block' : 'none' }}
        >
          <div className="resize-grip" aria-hidden />
        </PanelResizeHandle>

        <Panel
          ref={rightPanelRef}
          defaultSize={complete ? 45 : 0}
          minSize={0}
          onResize={(sz) => setRightSizePct(sz)}
        >
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
                ? 'Re-serializes on every edit. Build to dispatch.'
                : 'Fill target + disk to preview'}
            </p>
            <div
              className="min-h-0 flex-1"
              style={{
                opacity: complete ? 1 : 0,
                pointerEvents: complete ? 'auto' : 'none',
                transition: 'opacity 320ms ease 120ms',
              }}
            >
              <InteractiveYamlPreview
                yaml={memoedYaml}
                status={previewStatus}
                error={yamlError ?? undefined}
              />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Preview collapse/expand toggle.
       *
       * Position: absolute, `right: {rightSizePct}%`. As the user drags
       * the split, or as we RAF-animate the panel between 0% and their
       * last width, this offset tracks the panel boundary continuously
       * so the button feels welded to the divider.
       *
       * Icon: the same rotating chevron used by the accordion headers
       * (see components/Card.tsx Chevron), rotated -90° when the pane
       * is expanded ("points right — click to hide") and 90° when
       * collapsed ("points left — click to show").
       *
       * pointer-events: only enabled once the tab has resolved to
       * `complete` (there's something to hide/show).
       */}
      {complete && (
        <button
          type="button"
          onClick={togglePreview}
          aria-label={
            previewCollapsed ? 'Show template preview' : 'Hide template preview'
          }
          aria-pressed={previewCollapsed}
          title={
            previewCollapsed
              ? 'Show template preview'
              : 'Hide template preview'
          }
          className="cursor-pointer"
          style={{
            position: 'absolute',
            top: '50%',
            // Anchor the button so its centre tracks the divider line
            // when the preview is expanded (`calc(N% - 14px)`), but
            // clamp with `max(..., 8px)` so it can never slide beyond
            // the viewport's right edge. When the preview collapses to
            // 0%, `calc(0% - 14px)` would put the centre at -14 px and
            // half the button off-screen; the 8-px floor pins the full
            // button just inside the edge instead. Feels like the button
            // "docks" to the side when the preview is hidden.
            right: `max(calc(${rightSizePct}% - 14px), 8px)`,
            transform: 'translateY(-50%)',
            zIndex: 5,
            width: 28,
            height: 44,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            background: 'var(--section-background)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            color: 'var(--muted-color)',
            // No transition on `right`: `onResize` fires at 60fps during
            // both user drag and our RAF animation, so `rightSizePct`
            // updates each frame — a CSS transition here would lag
            // behind and cause the button to "float away" from the
            // moving panel edge.
            transition:
              'color 160ms ease, background-color 160ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--font-color)'
            e.currentTarget.style.background =
              'color-mix(in srgb, var(--classic-blue) 8%, var(--section-background))'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted-color)'
            e.currentTarget.style.background = 'var(--section-background)'
          }}
        >
          <PreviewToggleChevron collapsed={previewCollapsed} />
        </button>
      )}
      </div>

      <footer className="action-footer">
        <div className="flex items-center gap-3 px-6 py-3">
          <button
            className="cursor-pointer rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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

      <style>{`
        .interactive-page-shell {
          height: calc(100vh - 3.75rem);
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

/* ------------------------------------------------------------------------- *
 * PreviewToggleChevron — chevron glyph for the preview collapse toggle.
 * Same SVG path as the accordion Card's Chevron, rotated horizontally.
 *
 *   collapsed=false  -90°   points RIGHT  ("click to hide the preview")
 *   collapsed=true    90°   points LEFT   ("click to show the preview")
 * ------------------------------------------------------------------------- */
function PreviewToggleChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden="true"
      style={{
        color: 'currentColor',
        transform: collapsed ? 'rotate(90deg)' : 'rotate(-90deg)',
        transition: 'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
      }}
    >
      <path
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
        fill="currentColor"
      />
    </svg>
  )
}

/* ------------------------------------------------------------------------- *
 * Segmented — radio-style pill row.
 * ------------------------------------------------------------------------- */

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  // Sliding-pill indicator. Rather than paint each button's background on
  // its own and transition color, we render a single absolutely-positioned
  // <span> and animate its transform + width from the previous option's
  // box to the newly-selected option's box on every value change.
  //
  // On first paint the indicator should JUMP to its initial position (no
  // 0→X slide from the origin) — `enteredRef` gates the transition on
  // subsequent updates only.
  const groupRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{
    x: number
    w: number
    ready: boolean
  }>({ x: 0, w: 0, ready: false })
  const enteredRef = useRef(false)

  useLayoutEffect(() => {
    const group = groupRef.current
    const btn = buttonRefs.current[value]
    if (!group || !btn) return
    const groupRect = group.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    setIndicator({
      x: btnRect.left - groupRect.left,
      w: btnRect.width,
      ready: true,
    })
    // Delay flipping to "animated" state by one frame so the initial jump
    // to position paints instantly. Subsequent value changes see
    // enteredRef === true and animate.
    if (!enteredRef.current) {
      requestAnimationFrame(() => {
        enteredRef.current = true
      })
    }
  }, [value, options])

  // Recompute on resize — the pill needs to stay aligned to the button
  // even as flex-wrap reflows or the panel width changes.
  useEffect(() => {
    if (!groupRef.current) return
    const ro = new ResizeObserver(() => {
      const group = groupRef.current
      const btn = buttonRefs.current[value]
      if (!group || !btn) return
      const groupRect = group.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      setIndicator((prev) => ({
        ...prev,
        x: btnRect.left - groupRect.left,
        w: btnRect.width,
      }))
    })
    ro.observe(groupRef.current)
    return () => ro.disconnect()
  }, [value])

  return (
    <div className="mb-4">
      <span className={fieldLabelClass} style={fieldLabelStyle}>
        {label}
      </span>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={label}
        className="relative inline-flex flex-wrap gap-1 rounded-md border p-1"
        style={{
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
        }}
      >
        {/* Sliding indicator. z-0 so it sits behind the button labels;
         *  the buttons have transparent backgrounds and their text sits on
         *  top via z-10. `visibility: hidden` until the first measurement
         *  lands avoids a one-frame flash of the pill in the top-left. */}
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded pointer-events-none"
          style={{
            left: 0,
            width: indicator.w,
            transform: `translateX(${indicator.x}px)`,
            background: 'var(--classic-blue)',
            transition: enteredRef.current
              ? 'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1), width 220ms cubic-bezier(0.22, 0.7, 0.32, 1)'
              : 'none',
            visibility: indicator.ready ? 'visible' : 'hidden',
            zIndex: 0,
          }}
        />
        {options.map((o) => {
          const on = value === o.value
          return (
            <button
              key={o.value}
              ref={(el) => {
                buttonRefs.current[o.value] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              // focus-visible (not focus) so the ring only shows on keyboard
              // navigation. On mouse click the sliding pill IS the affordance
              // — a competing focus-ring flashed on top of it as a "black-
              // bordered box" during the 220ms slide.
              className="relative z-10 cursor-pointer rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--classic-blue)]"
              style={{
                background: 'transparent',
                // Only the label colour transitions per-button — the pill
                // itself slides beneath as one element.
                color: on ? 'white' : 'var(--font-color)',
                transition: 'color 220ms ease',
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * UserBlock — optional user account, toggled off by default.
 * ------------------------------------------------------------------------- */

const DEFAULT_USER: UserConfig = {
  name: '',
  password: '',
  hashAlgo: 'sha512',
  groups: [],
  sudo: false,
  home: '',
  shell: '/bin/bash',
}

const HASH_ALGO_ITEMS: ComboboxItem[] = [
  { value: 'sha512', label: 'sha512' },
  { value: 'bcrypt', label: 'bcrypt' },
]

function UserBlock({
  user,
  onChange,
}: {
  user: UserConfig | null
  onChange: (u: UserConfig | null) => void
}) {
  const enabled = user !== null
  const patch = (p: Partial<UserConfig>) =>
    onChange({ ...(user ?? DEFAULT_USER), ...p })
  // While Collapsible is animating the exit, `user` has already flipped to
  // null (the parent set it on checkbox uncheck). The fields still need
  // something to render against for those ~260ms. Fall back to the last
  // meaningful value or the DEFAULT_USER template so field inputs don't
  // throw during the close animation.
  const displayUser: UserConfig = user ?? DEFAULT_USER
  return (
    <div>
      <label
        className="flex cursor-pointer items-center gap-3 text-sm"
        style={{ color: 'var(--font-color)' }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            e.target.checked ? onChange({ ...DEFAULT_USER }) : onChange(null)
          }
          className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
        />
        Enable a default user
      </label>
      <Collapsible open={enabled} className="mt-3">
        <div
          className="grid gap-4 rounded-md border p-4 md:grid-cols-2"
          style={{
            borderColor: 'var(--border-color)',
            background: 'var(--input-background)',
          }}
        >
          <div>
            <label
              htmlFor="i-user-name"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Name
            </label>
            <TextInput
              id="i-user-name"
              value={displayUser.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="user"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-password"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Password
            </label>
            <TextInput
              id="i-user-password"
              type="password"
              value={displayUser.password}
              onChange={(e) => patch({ password: e.target.value })}
              placeholder="(hashed on server)"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label
              id="i-user-hashalgo-label"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Hash algorithm
            </label>
            <Combobox
              ariaLabelledBy="i-user-hashalgo-label"
              value={displayUser.hashAlgo}
              items={HASH_ALGO_ITEMS}
              placeholder="sha512"
              onChange={(v) =>
                patch({ hashAlgo: v === 'bcrypt' ? 'bcrypt' : 'sha512' })
              }
            />
          </div>
          <div>
            <label
              htmlFor="i-user-groups"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Groups (comma-separated)
            </label>
            <TextInput
              id="i-user-groups"
              value={displayUser.groups.join(', ')}
              onChange={(e) =>
                patch({
                  groups: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              placeholder="sudo, docker"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-home"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Home
            </label>
            <TextInput
              id="i-user-home"
              value={displayUser.home}
              onChange={(e) => patch({ home: e.target.value })}
              placeholder="/home/user"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-shell"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Shell
            </label>
            <TextInput
              id="i-user-shell"
              value={displayUser.shell}
              onChange={(e) => patch({ shell: e.target.value })}
              placeholder="/bin/bash"
            />
          </div>
          <label
            className="flex cursor-pointer items-center gap-3 text-sm md:col-span-2"
            style={{ color: 'var(--font-color)' }}
          >
            <input
              type="checkbox"
              checked={displayUser.sudo}
              onChange={(e) => patch({ sudo: e.target.checked })}
              className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
            />
            Passwordless sudo
          </label>
        </div>
      </Collapsible>
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * Display fallback — mirrors emptyInteractiveDraft from the store but is
 * defined here so we don't import an object that might be tree-shaken from
 * older store builds. Only used to keep the form populated before the first
 * edit materializes storeDraft.
 * ------------------------------------------------------------------------- */

const emptyDisplayDraft: InteractiveDraft = {
  imageName: '',
  imageVersion: '',
  target: { os: 'ubuntu', dist: 'ubuntu24', arch: 'x86_64', imageType: 'raw' },
  disk: { sizeGiB: 8, partitionTableType: 'gpt', partitions: [] },
  kernel: {
    version: '',
    cmdline: 'console=ttyS0,115200 console=tty0 loglevel=7',
    packages: [],
    enableExtraModules: '',
    uki: false,
  },
  packages: [],
  hostname: '',
  user: null,
  inheritedConfigurations: [],
  inheritedRepositories: [],
  baseDoc: null,
}
