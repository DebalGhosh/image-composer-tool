import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Manifest, Combination } from './api/types'

// --- Theme bootstrap ---------------------------------------------------------
//
// Runs at module load so the .dark class is on <html> BEFORE React first paints.
// A twin snippet in index.html runs even earlier (before any JS module loads)
// so cold reloads are FOUC-free too; this block keeps the store's `theme`
// field in lockstep with the class already on <html>.
//
// We reuse the SAME localStorage key that Header.tsx has been writing to
// (`ict.theme`), so no migration is required.

export type Theme = 'light' | 'dark'

const THEME_KEY = 'ict.theme'

/**
 * Resolves the theme for this page load.
 *
 * Dark is the product default: a first-time visitor lands in dark mode. The
 * OS `prefers-color-scheme` hint is deliberately NOT consulted — it used to
 * be the tiebreaker, but a default that follows the OS isn't a default, it's
 * a coin flip, and the operator-console surfaces (build log terminal, YAML
 * editor) are designed dark-first.
 *
 * Only an explicit stored `'light'` opts out. Testing for that rather than
 * for `'dark'` means an absent key, an unreadable store, and a corrupted
 * value all resolve to the default instead of silently reverting to light.
 *
 * Returning a stored value round-trips through setTheme, so a user's choice
 * still survives reloads in both directions — this changes the cold-start
 * default only.
 *
 * Twin of the inline bootstrap in index.html, which must apply the identical
 * rule earlier (before any module loads) to stay FOUC-free. Change both.
 */
function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    if (window.localStorage.getItem(THEME_KEY) === 'light') return 'light'
  } catch {
    /* localStorage may be unavailable in private modes — fall through to the
     * default, matching index.html's behaviour when the read throws. */
  }
  return 'dark'
}

function applyThemeClass(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

const initialTheme = readInitialTheme()
applyThemeClass(initialTheme)

// Selection state for the Basic tab.
export interface Selection {
  vertical: string
  sku: string
  platform: string
  os: string
  kernel: string
  imageType: string
}

// --- Toast slice --------------------------------------------------------
// Kept in the app store (rather than a separate provider) so any component
// can push a toast without threading context through the tree. The container
// subscribes to `toasts` and renders them top-right.

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger'

export interface Toast {
  id: string
  variant: ToastVariant
  title?: string
  message: string
  /**
   * Auto-dismiss delay in ms. 0 or negative means "sticky — user must dismiss".
   * Default (set by pushToast) is 5000ms.
   */
  duration: number
}

export interface ToastInput {
  variant: ToastVariant
  title?: string
  message: string
  duration?: number
}

// --- Interactive-tab draft model ---------------------------------------
// Structured, form-editable model of a CoreV1 image spec. The Interactive
// tab edits this shape; on Build the same object is serialized to YAML and
// posted to the same backend as the Advanced/Basic tabs. Kept in the store
// (rather than local component state) so tab switches don't discard edits,
// mirroring the advancedYaml slice above.

export interface Partition {
  id: string
  name: string
  role: 'efi' | 'bios-boot' | 'swap' | 'root' | 'verity' | 'userdata' | 'custom'
  sizeMiB: number
  /**
   * Absolute start offset of the FIRST partition, in MiB, as written by the
   * source template. Only meaningful on partitions[0]; later partitions are
   * always packed end-to-end from the previous one.
   *
   * Templates conventionally start at 1MiB for alignment
   * (`start: "1MiB"`, `end: "513MiB"`). The draft models partitions by SIZE,
   * so without capturing this the serializer restarted at 0MiB and shifted
   * every boundary down by 1MiB — silently changing the disk layout of 34 of
   * the 59 shipped templates. Stored so an untouched round-trip reproduces the
   * source byte-for-byte.
   */
  startOffsetMiB?: number
  fillRemaining?: boolean
  type: string
  fsType: string
  fsLabel?: string
  mountPoint: string
  mountOptions?: string
  flags: string[]
  typeUUID?: string
}

export interface UserConfig {
  name: string
  password: string
  hashAlgo: 'sha512' | 'bcrypt'
  groups: string[]
  sudo: boolean
  home: string
  shell: string
}

export interface InteractiveDraft {
  imageName: string
  imageVersion: string
  target: { os: string; dist: string; arch: string; imageType: string }
  disk: {
    sizeGiB: number
    partitionTableType: 'gpt' | 'mbr'
    partitions: Partition[]
  }
  kernel: {
    version: string
    cmdline: string
    packages: string[]
    enableExtraModules: string
    uki: boolean
  }
  packages: string[]
  hostname: string
  /** Single user in v1 — null means "no user block emitted". */
  user: UserConfig | null
  /**
   * Read-only round-trip carriers: sections we parse out of a loaded seed
   * but don't yet expose in the form. Kept on the draft so a Build after
   * an Interactive edit preserves them verbatim.
   */
  inheritedConfigurations: { cmd: string }[]
  inheritedRepositories: unknown[]
  /** Raw parsed YAML from the seed (or null when starting empty). */
  baseDoc: unknown | null
  /**
   * The seed's ORIGINAL YAML text, exactly as served. Retained so that a draft
   * the user never edited can be dispatched byte-for-byte instead of being
   * re-serialized from the form model.
   *
   * Reconstructing is inherently lossy: the form models a subset of the schema,
   * so any field it doesn't represent (and any value it normalises differently
   * — partition alignment, MB vs MiB, extra users) comes out changed. Cycling
   * templates in a dropdown without touching a control must not alter the
   * template, so applyOverrides short-circuits to this string when the draft
   * still round-trips equal to it. null when authoring from scratch.
   */
  baseYaml: string | null
}

export const emptyInteractiveDraft: InteractiveDraft = {
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

interface AppState {
  manifest: Manifest | null
  selection: Selection
  // Advanced tab draft. Lifted into the store so switching tabs
  // (Advanced -> Build Image -> Advanced) doesn't lose the operator's
  // unsaved YAML edits.
  advancedYaml: string
  /**
   * Advanced-tab seed-dropdown selection (empty string = no seed picked).
   * Persisted in the store so:
   *   (a) the dropdown shows which template the current YAML came from,
   *   (b) switching tabs and coming back preserves the picked-seed indicator.
   * The Reload button next to the dropdown re-fires the same seed if the
   * operator wants to discard their edits and start over.
   */
  advancedSeedPick: string
  /**
   * Interactive-tab draft. null means "the operator hasn't touched the tab
   * yet"; the first edit or seed-load materializes it (from
   * emptyInteractiveDraft or the parsed seed respectively).
   */
  interactiveDraft: InteractiveDraft | null
  /** Interactive-tab seed-dropdown selection — same contract as advancedSeedPick. */
  interactiveSeedPick: string
  theme: Theme
  toasts: Toast[]
  setManifest: (m: Manifest) => void
  setField: (key: keyof Selection, value: string) => void
  setAdvancedYaml: (yaml: string) => void
  setAdvancedSeedPick: (v: string) => void
  /** Shallow-merge patch into the current draft (materializing from empty if null). */
  setInteractiveDraft: (patch: Partial<InteractiveDraft>) => void
  /** Clear the draft and the seed-dropdown pick together (Reset button). */
  resetInteractiveDraft: () => void
  setInteractiveSeedPick: (v: string) => void
  /** Full replacement — used after parsing a freshly loaded seed. */
  loadInteractiveDraft: (draft: InteractiveDraft) => void
  setTheme: (theme: Theme) => void
  pushToast: (t: ToastInput) => string
  dismissToast: (id: string) => void
}

// Monotonic id — avoids Math.random collisions when several toasts land in
// the same tick (e.g. concurrent api errors on initial load).
let toastCounter = 0
const nextToastId = () => `t${Date.now().toString(36)}-${(toastCounter++).toString(36)}`

const emptySelection: Selection = {
  vertical: '',
  sku: '',
  platform: '',
  os: '',
  kernel: '',
  imageType: '',
}

// Persistence key + version. Bump `version` when the shape of the persisted
// slice changes incompatibly — Zustand will drop the stale blob rather than
// try to load it into the new shape.
const PERSIST_KEY = 'ict.store'
// Bumped 1 -> 2 when InteractiveDraft.baseYaml was introduced. A draft
// persisted by the previous version has no baseYaml, so the pristine
// passthrough in applyOverrides cannot fire and the draft would be
// reconstructed (lossily) on dispatch. zustand's persist middleware discards
// state whose version is older than this and no migrate() is supplied, which is
// exactly what we want: a stale draft is cheap to reload from the seed dropdown
// and expensive to dispatch wrong.
const PERSIST_VERSION = 2

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      manifest: null,
  selection: emptySelection,
  advancedYaml: '',
  advancedSeedPick: '',
  interactiveDraft: null,
  interactiveSeedPick: '',
  theme: initialTheme,
  toasts: [],
  setManifest: (m) => set({ manifest: m }),
  setAdvancedYaml: (yaml) => set({ advancedYaml: yaml }),
  setAdvancedSeedPick: (v) => set({ advancedSeedPick: v }),
  setInteractiveDraft: (patch) =>
    set((state) => {
      const base = state.interactiveDraft ?? emptyInteractiveDraft
      return { interactiveDraft: { ...base, ...patch } }
    }),
  resetInteractiveDraft: () =>
    set({ interactiveDraft: null, interactiveSeedPick: '' }),
  setInteractiveSeedPick: (v) => set({ interactiveSeedPick: v }),
  loadInteractiveDraft: (draft) => set({ interactiveDraft: draft }),
  setTheme: (theme) => {
    try {
      window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    applyThemeClass(theme)
    set({ theme })
  },
  pushToast: (t) => {
    const id = nextToastId()
    const toast: Toast = {
      id,
      variant: t.variant,
      title: t.title,
      message: t.message,
      duration: t.duration ?? 5000,
    }
    set((state) => ({ toasts: [...state.toasts, toast] }))
    return id
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })),
  setField: (key, value) =>
    set((state) => {
      const selection = { ...state.selection, [key]: value }
      // Reset downstream fields when an upstream one changes, so the cascade
      // never leaves an invalid combination selected.
      // Cascade order: vertical → sku → platform → os → kernel → imageType.
      if (key === 'vertical') {
        selection.sku = ''
        selection.platform = ''
        selection.os = ''
        selection.kernel = ''
        selection.imageType = ''
      } else if (key === 'sku') {
        selection.platform = ''
        selection.os = ''
        selection.kernel = ''
        selection.imageType = ''
      } else if (key === 'platform') {
        selection.os = ''
        selection.kernel = ''
        selection.imageType = ''
      } else if (key === 'os') {
        selection.kernel = ''
        selection.imageType = ''
      } else if (key === 'kernel') {
        selection.imageType = ''
      }
      return { selection }
    }),
}),
    {
      name: PERSIST_KEY,
      version: PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Only persist the fields the user would expect to survive a reload.
      // Manifest is refetched at boot so persisting it would just delay the
      // first paint with stale data. Theme is already persisted independently
      // under `ict.theme`. Toasts and busy-flags are ephemeral by design.
      partialize: (state) => ({
        interactiveDraft: state.interactiveDraft,
        interactiveSeedPick: state.interactiveSeedPick,
        advancedYaml: state.advancedYaml,
        advancedSeedPick: state.advancedSeedPick,
        selection: state.selection,
      }),
    },
  ),
)

// --- Derived cascading option helpers (pure functions over the manifest) ---

function labelFor(options: { id: string; displayName: string }[], id: string): string {
  return options.find((o) => o.id === id)?.displayName ?? id
}

// Distinct ids present in combinations, optionally filtered by prior selections.
function distinct(
  combos: Combination[],
  field: keyof Combination,
  filter: Partial<Selection>,
): string[] {
  const out: string[] = []
  for (const c of combos) {
    const matches = Object.entries(filter).every(
      ([k, v]) => !v || c[k as keyof Combination] === v,
    )
    if (matches && c[field] && !out.includes(c[field] as string)) {
      out.push(c[field] as string)
    }
  }
  return out
}

export interface DropdownOption {
  id: string
  label: string
}

export function cascadingOptions(
  manifest: Manifest,
  selection: Selection,
): {
  verticals: DropdownOption[]
  skus: DropdownOption[]
  platforms: DropdownOption[]
  oses: DropdownOption[]
  kernels: DropdownOption[]
  imageTypes: DropdownOption[]
  matched: Combination | null
} {
  const c = manifest.combinations
  const map = (ids: string[], labels: { id: string; displayName: string }[]) =>
    ids.map((id) => ({ id, label: labelFor(labels, id) }))

  const verticals = map(distinct(c, 'vertical', {}), manifest.verticals)
  const skus = map(
    distinct(c, 'sku', { vertical: selection.vertical }),
    manifest.skus,
  )
  const platforms = map(
    distinct(c, 'platform', { vertical: selection.vertical, sku: selection.sku }),
    manifest.platforms,
  )
  const oses = map(
    distinct(c, 'os', {
      vertical: selection.vertical,
      sku: selection.sku,
      platform: selection.platform,
    }),
    manifest.targets,
  )

  // Kernel is an optional dimension: only combinations that carry a kernel value
  // contribute. When none do, kernels is empty and the UI omits the selector —
  // so RT vs standard is surfaced only where the metadata actually offers it.
  const kernelIds = distinct(c, 'kernel', {
    vertical: selection.vertical,
    sku: selection.sku,
    platform: selection.platform,
    os: selection.os,
  })
  const kernelLabels: Record<string, string> = { standard: 'Standard', rt: 'Real-Time' }
  const kernels = kernelIds.map((id) => ({ id, label: kernelLabels[id] ?? id }))

  const imageTypeIds = distinct(c, 'imageType', {
    vertical: selection.vertical,
    sku: selection.sku,
    platform: selection.platform,
    os: selection.os,
    ...(kernels.length > 0 ? { kernel: selection.kernel } : {}),
  })
  const imageTypes = imageTypeIds.map((id) => ({ id, label: id.toUpperCase() }))

  const matched =
    c.find(
      (x) =>
        x.vertical === selection.vertical &&
        (x.sku || '') === selection.sku &&
        x.platform === selection.platform &&
        x.os === selection.os &&
        (x.kernel || '') === selection.kernel &&
        x.imageType === selection.imageType,
    ) ?? null

  return { verticals, skus, platforms, oses, kernels, imageTypes, matched }
}

// --- useToast hook ------------------------------------------------------
// Thin ergonomic wrapper over pushToast/dismissToast. Callers get typed
// helpers (`toast.danger(...)`) instead of remembering the variant string.
// The returned object is memoized so passing it into effect deps is safe.

export interface ToastHelpers {
  info: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  success: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  warning: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  danger: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  dismiss: (id: string) => void
}

export function useToast(): ToastHelpers {
  const push = useStore((s) => s.pushToast)
  const dismiss = useStore((s) => s.dismissToast)
  return useMemo<ToastHelpers>(
    () => ({
      info: (message, opts) => push({ ...opts, variant: 'info', message }),
      success: (message, opts) => push({ ...opts, variant: 'success', message }),
      warning: (message, opts) => push({ ...opts, variant: 'warning', message }),
      danger: (message, opts) => push({ ...opts, variant: 'danger', message }),
      dismiss,
    }),
    [push, dismiss],
  )
}
