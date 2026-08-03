import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Manifest } from '@/api/types'
import type {
  InteractiveDraft,
  Selection,
  Toast,
  ToastInput,
} from './store/types'
import { emptyInteractiveDraft } from './store/types'
import type { Theme } from './store/theme'
import { applyThemeClass, initialTheme, THEME_KEY } from './store/theme'

/**
 * The app store: one Zustand store, four slices' worth of state.
 *
 * FE-7b split the SHAPES (store/types.ts), the theme bootstrap
 * (store/theme.ts), the Basic tab's dependent-dropdown logic
 * (store/cascade.ts) and the toast ergonomics hook (store/useToast.ts) into
 * their own modules. What stayed is the part that genuinely cannot move: the
 * single `create()` call and its persist configuration.
 *
 * ⚠️ THE STORE WAS NOT SPLIT INTO FOUR ZUSTAND STORES, AND MUST NOT BE.
 * `partialize` names five fields across three of those "slices", and they are
 * persisted TOGETHER under one key as one JSON blob. Four stores would mean four
 * keys, which is a persisted-shape change — and PERSIST_VERSION is 2 with NO
 * migrate(), so Zustand would find nothing at the old key and every operator
 * with an in-progress draft would lose it on their next reload.
 *
 * Re-exports below keep '@/store' the single import site it has always been for
 * all 18 consumers. Moving a symbol between store/ modules therefore costs
 * nothing outside this directory.
 */

// Re-exported so consumers keep importing from '@/store'.
export type {
  InteractiveDraft,
  Partition,
  PartitionRole,
  Selection,
  Toast,
  ToastInput,
  ToastVariant,
  UserConfig,
} from './store/types'
export type { Theme } from './store/theme'
export { emptyInteractiveDraft } from './store/types'
export type { DropdownOption } from './store/cascade'
export { cascadingOptions } from './store/cascade'
export type { ToastHelpers } from './store/useToast'
export { useToast } from './store/useToast'


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
