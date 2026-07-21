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
  type CSSProperties,
} from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import MiniSearch from 'minisearch'
import { useStore, useToast, type InteractiveDraft, type UserConfig } from '../store'
import { api } from '../api/client'
import type { ComposeRequest, PackageEntry } from '../api/types'
import { Card } from './Card'
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
import { YamlEditor } from './YamlEditor'
import { PackageSearchCombobox } from './PackageSearchCombobox'
import { InteractiveYamlPreview } from './InteractiveYamlPreview'
import { applyOverrides, parseYamlToDraft } from '../lib/draftFromYaml'

interface InteractivePageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
  buildInProgress: boolean
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

export function InteractivePage({ onBuildStarted, buildInProgress }: InteractivePageProps) {
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

  useEffect(() => {
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
  }, [complete])

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
    if (!complete || busy || buildInProgress) return
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
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={complete ? 55 : 100} minSize={35}>
          <div className="h-full overflow-y-auto p-6">
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

            {/* 1. Seed */}
            <Card
              title="Seed from template"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="flex items-stretch gap-2">
                <NativeSelect
                  id="interactive-seed"
                  value={seedPick}
                  disabled={seedBusy || busy}
                  onChange={(e) => onSeedChange(e.target.value)}
                  containerClassName="min-w-0 flex-1"
                >
                  <option value="">
                    {seedBusy ? 'Loading seed…' : '-- Pick a template to prefill --'}
                  </option>
                  {manifest.combinations.map((c, i) => (
                    <option key={`${c.template}-${i}`} value={i}>
                      {seedLabel(i)}
                    </option>
                  ))}
                </NativeSelect>
                <button
                  type="button"
                  onClick={onReloadSeed}
                  disabled={!seedPick || seedBusy || busy}
                  className="cursor-pointer rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--font-color)' }}
                  title={
                    seedPick
                      ? 'Discard local edits and reload the selected seed'
                      : 'Pick a seed first'
                  }
                  aria-label="Reload seed template"
                >
                  ↻ Reload
                </button>
              </div>
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

            {/* 3. Target */}
            <Card
              title="Target"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
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
              <div className="mt-4">
                <Segmented
                  label="Architecture"
                  value={draft.target.arch}
                  options={ARCH_OPTIONS}
                  onChange={(v) => patchTarget({ arch: v })}
                />
              </div>
              <div>
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
                max={64}
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
                  rows={1}
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
        </Panel>

        <PanelResizeHandle
          className="resize-handle group"
          style={{ display: complete ? 'block' : 'none' }}
        >
          <div className="resize-grip" aria-hidden />
        </PanelResizeHandle>

        <Panel ref={rightPanelRef} defaultSize={complete ? 45 : 0} minSize={0}>
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

      <footer className="action-footer">
        <div className="flex items-center gap-3 px-6 py-3">
          <button
            className="cursor-pointer rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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
  return (
    <div className="mb-4">
      <span className={fieldLabelClass} style={fieldLabelStyle}>
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex flex-wrap gap-1 rounded-md border p-1"
        style={{
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
        }}
      >
        {options.map((o) => {
          const on = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              className="cursor-pointer rounded px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)]"
              style={{
                background: on ? 'var(--classic-blue)' : 'transparent',
                color: on ? 'white' : 'var(--font-color)',
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
      {enabled && user && (
        <div
          className="mt-3 grid gap-4 rounded-md border p-4 md:grid-cols-2"
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
              value={user.name}
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
              value={user.password}
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
              value={user.hashAlgo}
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
              value={user.groups.join(', ')}
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
              value={user.home}
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
              value={user.shell}
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
              checked={user.sudo}
              onChange={(e) => patch({ sudo: e.target.checked })}
              className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
            />
            Passwordless sudo
          </label>
        </div>
      )}
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
