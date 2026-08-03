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
  useMemo,
  useRef,
  useState,
} from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore, useToast, type InteractiveDraft, type UserConfig } from '@/store'
import { usePanelAnimation } from '@/hooks/usePanelAnimation'
import {
  OS_OPTIONS,
  DIST_BY_OS,
  ARCH_OPTIONS,
  IMAGE_TYPE_OPTIONS,
  KERNEL_VERSIONS_BY_DIST,
  KERNEL_PACKAGES_BY_DIST,
  IMAGE_NAME_RE,
} from './model/options'
import { useCommandPalette } from './hooks/useCommandPalette'
import { PreviewToggleChevron } from './parts/PreviewToggleChevron'
import { Segmented } from './parts/Segmented'
import { ImageSection } from './parts/ImageSection'
import { DiskSection } from './parts/DiskSection'
import { PackagesSection } from './parts/PackagesSection'
import { SystemSection } from './parts/SystemSection'
import { InheritedSection } from './parts/InheritedSection'
import { api } from '@/api/client'
import type { ComposeRequest } from '@/api/types'
import { Card } from '@/components/layout/Card'
import { Combobox, type ComboboxItem } from '@/components/controls/Combobox'
import {
  MultiCombobox,
  type MultiComboboxOption,
} from '@/components/controls/MultiCombobox'
import {
  NativeSelect,
  TextInput,
  TextArea,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'
import type { Arch } from '@/features/partitions'
import { PackageSearchDialog } from '@/features/package-search'
import { InteractiveYamlPreview } from './InteractiveYamlPreview'
import { applyOverrides, parseYamlToDraft } from '@/lib/draftFromYaml'

interface InteractivePageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
}
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
  // Expanded package-search dialog visibility. Opened by the icon
  // button on the Packages card OR by Cmd/Ctrl+K when this tab is the
  // active view (checked via the wrapper div's `hidden` attribute at
  // keystroke time so we don't trigger the shortcut from other tabs).
  // See hooks/useCommandPalette for the offsetParent guard.
  const {
    open: pkgDialogOpen,
    setOpen: setPkgDialogOpen,
    rootRef,
  } = useCommandPalette()

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
  // The rAF machinery now lives in hooks/usePanelAnimation, shared with
  // BuildImagePage and BasicPage. (This is the TODO(v2) that used to sit here:
  // "dedupe with BasicPage. Copied verbatim from BasicPage.tsx:48-95".)
  const {
    panelRef: rightPanelRef,
    animateTo: animatePanel,
    cancel: cancelAnimation,
  } = usePanelAnimation()
  const prevCompleteRef = useRef<boolean | null>(null)

  /* -------------------- User-driven collapse of the preview pane ---------- *
   * Independent of `complete`. When the user clicks the toggle chevron on
   * the divider, we animate the panel to 0% width and remember the size
   * they were on so re-expand goes back to the same width. If they never
   * dragged, the fallback is 45% — the same as the auto-open size.
   */
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
  const lastExpandedSizeRef = useRef<number>(45)


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

    // Auto-open/close uses the SAME animation instance as the manual toggle
    // above, which is what makes the two mutually cancelling: a `complete` flip
    // mid-toggle must not leave two rAF loops driving one handle from different
    // `from` values. (Before the hook, both paths shared a single local rafRef
    // for exactly this reason.)
    //
    // snapWhenClose: false — when the pane is already within 0.5% of the target
    // this path leaves it alone rather than snapping to it. That is the
    // behaviour this effect has always had, and it differs from the toggle's.
    animatePanel(complete ? 45 : 0, complete ? 520 : 380, { snapWhenClose: false })

    return cancelAnimation
  }, [complete, previewCollapsed, rightPanelRef, animatePanel, cancelAnimation])

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
        // Two documents, two jobs.
        //
        // The MERGED form (?form=merged) is what populates the form: it has the
        // OSV defaults folded in, so the operator sees resolved values rather
        // than blanks. But it is a Go-marshalled dump — PascalCase keys plus
        // internal fields (FullPkgList, DotFilePath, …) — and is NOT a valid
        // user template. Dispatching it produces a document in which
        // `systemConfig`, `disk`, `bootloader` and friends are simply absent,
        // which the backend now rejects outright as INVALID_TEMPLATE.
        //
        // So the RAW template is fetched alongside it and stashed as the
        // draft's baseYaml. That makes the raw template the passthrough
        // reference: cycling seeds without editing dispatches the template
        // exactly as it exists on disk, while the form still shows merged
        // values. A raw fetch failure is non-fatal — we just lose the
        // byte-exact passthrough and fall back to reconstruction.
        const [merged, raw] = await Promise.all([
          api.composeMerged(req),
          api.compose(req).catch(() => null),
        ])
        if (raw?.yaml) {
          // Raw available: the form is hydrated from the RAW template and the
          // raw text becomes the passthrough reference, so what the operator
          // sees is what gets dispatched. Showing merged values here would
          // mean previewing one document and building another — the exact
          // class of mismatch that shipped two wrong images.
          loadDraft({ ...parseYamlToDraft(raw.yaml), baseYaml: raw.yaml })
        } else {
          // No raw form (older backend): fall back to the merged seed. The
          // backend's schema guard will reject it on dispatch rather than let
          // a Go-marshalled dump reach a worker.
          loadDraft(parseYamlToDraft(merged.yaml))
        }
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
    <div className="page-shell" ref={rootRef}>
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
          {/* @container makes this pane the reference box for every
           * `@max-pane-*` / `@min-pane-*` utility below it, so the form grids
           * respond to the width the user dragged rather than the window's.
           *
           * It lives HERE, once per pane, and deliberately not on individual
           * Cards or partition rows. `container-type: inline-size` implies
           * `contain: layout`, which creates a stacking context — and a
           * stacking context paints atomically. On a card body that would
           * confine an open Combobox dropdown (z-30) inside the card, letting
           * the next sibling card's opaque background paint over it. One
           * container per pane keeps every card and dropdown in the SAME
           * stacking context, so nothing about their layering changes.
           *
           * Also safe here for the position:fixed hazard: layout containment
           * makes this a containing block for fixed descendants, but this
           * pane holds no fixed-position UI — the YAML preview (and its
           * fullscreen-capable YamlEditor) is in the OTHER pane, and the
           * PackageSearchDialog renders outside the PanelGroup entirely.
           * That is exactly why AdvancedPage, whose editor sits in the
           * scrolling flow, gets no marker at all. */}
          <div className="@container h-full overflow-y-auto">
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
            <ImageSection
              imageName={draft.imageName}
              imageVersion={draft.imageVersion}
              onNameChange={(v) => setDraft({ imageName: v })}
              onVersionChange={(v) => setDraft({ imageVersion: v })}
              imageNameInvalid={imageNameInvalid}
            />

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
              {/* Row 1: OS + Distribution — dropdowns, gated cascade.
               *
               * Container query, not md:. This lives inside a resizable pane
               * whose width is viewport x userDraggedFraction, so md: would
               * measure the wrong box — and get it backwards: two columns are
               * NARROWER at a 1024px viewport (md: on, 229px each) than at
               * 767px (md: off, 334px). @max-pane-2col measures the Card. */}
              <div className="@max-pane-2col:grid-cols-1 grid grid-cols-2 gap-4">
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
              <div className="@max-pane-2col:grid-cols-1 grid grid-cols-2 gap-4">
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
            <DiskSection
              disk={draft.disk}
              arch={draft.target.arch as Arch}
              onPatch={patchDisk}
            />

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
            <PackagesSection
              packages={draft.packages}
              dist={draft.target.dist}
              arch={draft.target.arch}
              onChange={(next) => setDraft({ packages: next })}
              onOpenDialog={() => setPkgDialogOpen(true)}
            />

            {/* 7. System */}
            <SystemSection
              hostname={draft.hostname}
              onHostnameChange={(v) => setDraft({ hostname: v })}
              user={draft.user}
              onUserChange={patchUser}
            />

            {/* 8. Inherited */}
            {showInherited && (
              <InheritedSection
                configurationCount={draft.inheritedConfigurations.length}
                repositoryCount={draft.inheritedRepositories.length}
              />
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

      {/* Expanded package-search overlay. Opens via the "Advanced search"
       * button on the Packages card OR the Cmd/Ctrl+K global shortcut when
       * this tab is on screen. Shares the same values/onChange contract
       * with the inline PackageSearchCombobox — anything the dialog adds
       * shows up as a chip below the input the moment the dialog closes. */}
      <PackageSearchDialog
        open={pkgDialogOpen}
        onClose={() => setPkgDialogOpen(false)}
        values={draft.packages}
        onChange={(next) => setDraft({ packages: next })}
        os={draft.target.dist}
        arch={draft.target.arch}
      />
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
  baseYaml: null,
}
