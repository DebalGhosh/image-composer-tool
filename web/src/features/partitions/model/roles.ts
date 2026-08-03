/**
 * Role presets, GPT type UUIDs and the option tables for the partition editor.
 * Pure data + two lookups — no React, no DOM.
 *
 * ⚠️ THE UUIDs BELOW MUST NOT DRIFT. They come from the freedesktop
 * Discoverable Partitions Specification and a wrong one produces an image that
 * builds successfully and then does not boot — nothing in this repo's gates can
 * see that. roles.test.ts pins each string exactly for precisely that reason.
 *
 * Moved verbatim out of SegmentedPartitionEditor.tsx; values unchanged.
 */
import type { ComboboxItem } from '@/components/controls/Combobox'
import type { PartitionRole } from '@/types/partition'

/**
 * Architectures we know how to map onto `linux-root-<arch>` GPT partition
 * types. Anything not in this table (armv7hl, etc.) falls back to plain
 * `linux` with no typeUUID — safe default, ICT builds still succeed.
 */
export type Arch = 'x86_64' | 'aarch64' | 'armv7hl'

export interface RolePreset {
  label: string
  id: string
  name: string
  defaultSizeMiB: number
  /** UI slider floor. Ignored when the role has fillRemaining set. */
  minMiB: number
  /** UI slider ceiling. Roles with `null` accept any size up to disk. */
  maxMiB: number | null
  /** True when the widget should offer "Fill remaining" as an option. */
  supportsFill: boolean
  type: string
  fsType: string
  mountPoint: string
  flags: string[]
  typeUUID?: string
  /** Diagnostic swatch on the visual bar and role chip. */
  color: string
  /** Emoji-free glyph SVG name. */
  glyph: string
}

// GPT partition type UUIDs from
//   https://uapi-group.org/specifications/specs/discoverable_partitions_specification/
const UUID_ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
const UUID_BIOS_BOOT = '21686148-6449-6e6f-744e-656564454649'
const UUID_SWAP = '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f'
const UUID_ROOT_AMD64 = '4f68bce3-e8cd-4db1-96e7-fbcaf984b709'
const UUID_ROOT_ARM64 = 'b921b045-1df0-41c3-af44-4c6f280d3fae'

/** Per-role visual + default table. */
export const ROLE_PRESETS: Record<Exclude<PartitionRole, 'custom'>, RolePreset> = {
  efi: {
    label: 'EFI',
    id: 'efi',
    name: 'EFI System',
    defaultSizeMiB: 100,
    minMiB: 100,
    maxMiB: 1024,
    supportsFill: false,
    type: 'esp',
    fsType: 'fat32',
    mountPoint: '/boot/efi',
    flags: ['esp', 'boot'],
    typeUUID: UUID_ESP,
    color: '#f59e0b',
    glyph: 'efi',
  },
  'bios-boot': {
    label: 'BIOS-Boot',
    id: 'bios-boot',
    name: 'BIOS Boot',
    defaultSizeMiB: 5,
    minMiB: 1,
    maxMiB: 5,
    supportsFill: false,
    type: 'bios-boot',
    fsType: '',
    mountPoint: 'none',
    flags: ['bios_grub'],
    typeUUID: UUID_BIOS_BOOT,
    color: '#ea580c',
    glyph: 'bios',
  },
  swap: {
    label: 'Swap',
    id: 'swap',
    name: 'Swap',
    defaultSizeMiB: 2048,
    minMiB: 512,
    maxMiB: 8192,
    supportsFill: false,
    type: 'linux-swap',
    fsType: 'linux-swap',
    mountPoint: 'none',
    flags: [],
    typeUUID: UUID_SWAP,
    color: '#8b5cf6',
    glyph: 'swap',
  },
  root: {
    label: 'Root',
    id: 'root',
    name: 'Root',
    defaultSizeMiB: 4096,
    minMiB: 1024,
    maxMiB: null,
    supportsFill: true,
    type: 'linux-root-amd64', // rewritten by rootTypeFor(arch) on add
    fsType: 'ext4',
    mountPoint: '/',
    flags: [],
    typeUUID: UUID_ROOT_AMD64,
    color: '#2563eb',
    glyph: 'root',
  },
  verity: {
    label: 'Verity',
    id: 'verity',
    name: 'Verity',
    defaultSizeMiB: 500,
    minMiB: 500,
    maxMiB: 500,
    supportsFill: false,
    type: 'linux',
    fsType: 'ext4',
    mountPoint: 'none',
    flags: [],
    color: '#0d9488',
    glyph: 'verity',
  },
  userdata: {
    label: 'Userdata',
    id: 'userdata',
    name: 'User Data',
    defaultSizeMiB: 1024,
    minMiB: 256,
    maxMiB: null,
    supportsFill: true,
    type: 'linux',
    fsType: 'ext4',
    mountPoint: '/opt',
    flags: [],
    color: '#16a34a',
    glyph: 'userdata',
  },
}

export const CUSTOM_COLOR = '#64748b' // slate

/**
 * Filesystem picker options — the intersection of what ICT + osbuild accept.
 * We keep the raw select-value equal to the ICT string; the label is UI-only.
 */
export const FS_TYPE_OPTIONS: ComboboxItem[] = [
  { value: '', label: '(none)' },
  { value: 'ext4', label: 'ext4' },
  { value: 'xfs', label: 'xfs' },
  { value: 'btrfs', label: 'btrfs' },
  { value: 'fat32', label: 'fat32 (vfat)' },
  { value: 'linux-swap', label: 'linux-swap' },
]

export const MOUNT_POINT_PRESETS: ComboboxItem[] = [
  { value: 'none', label: '(unmounted)' },
  { value: '/', label: '/  (root)' },
  { value: '/boot', label: '/boot' },
  { value: '/boot/efi', label: '/boot/efi' },
  { value: '/home', label: '/home' },
  { value: '/opt', label: '/opt' },
  { value: '/var', label: '/var' },
  { value: '/tmp', label: '/tmp' },
  { value: '__other__', label: 'Other…' },
]

/** GPT flags the UI offers as one-click chips; free-form is not supported. */
export const FLAG_CHOICES = ['boot', 'esp', 'bios_grub', 'legacy_boot', 'hidden']

/* ------------------------------------------------------------------------- *
 * Arch → root type + UUID
 * ------------------------------------------------------------------------- */

export function rootTypeFor(arch: Arch): { type: string; typeUUID: string | undefined } {
  if (arch === 'x86_64') {
    return { type: 'linux-root-amd64', typeUUID: UUID_ROOT_AMD64 }
  }
  if (arch === 'aarch64') {
    return { type: 'linux-root-arm64', typeUUID: UUID_ROOT_ARM64 }
  }
  // armv7hl / other — no standard type UUID in the discoverable-partitions spec;
  // fall back to `linux`, which osbuild accepts.
  return { type: 'linux', typeUUID: undefined }
}

/* ------------------------------------------------------------------------- *
 * Public component
 * ------------------------------------------------------------------------- */

/**
 * Preset for a role, or null for 'custom'.
 *
 * null rather than a default preset is the contract: 'custom' means the user
 * owns every field, so callers must treat a null preset as "no guardrails"
 * (min 1 MiB, max = disk) rather than substituting another role's limits.
 */
export function presetFor(role: PartitionRole): RolePreset | null {
  if (role === 'custom') return null
  return ROLE_PRESETS[role]
}
