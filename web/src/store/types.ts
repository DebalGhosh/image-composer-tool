/**
 * The store's data shapes.
 *
 * Types only, plus `emptyInteractiveDraft` — which is a value but a CONSTANT,
 * and lives here because it is the canonical shape of a draft rather than a
 * piece of store behaviour.
 *
 * ⚠️ EVERY FIELD OF `InteractiveDraft` AND `Selection` IS PERSISTED. They are
 * both named in the store's `partialize`, so renaming or restructuring any field
 * here silently breaks rehydration: PERSIST_VERSION is 2 and there is NO
 * migrate(), so Zustand discards state whose version does not match — and
 * changing a field shape without bumping the version means it does NOT discard,
 * it rehydrates the wrong shape. Either is a lost draft. Split in FE-7b as a
 * pure move for exactly that reason.
 */

// `Partition` is both IMPORTED (InteractiveDraft.disk.partitions references it
// below) and RE-EXPORTED (consumers have long imported it from '@/store'). An
// `export type { ... } from` alone would do the second without the first.
import type { Partition } from '@/types/partition'

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

// Partition now lives in types/partition.ts — it was declared here AND in
// SegmentedPartitionEditor with differing fields. Re-exported so existing
// importers (notably lib/draftFromYaml.ts, which is fenced by
// .claude/YAML-INTEGRITY.md and deliberately left untouched) keep working.
export type { Partition, PartitionRole } from '@/types/partition'

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
