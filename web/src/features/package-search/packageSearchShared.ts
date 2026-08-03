/**
 * packageSearchShared — helpers shared between the inline
 * `PackageSearchCombobox` and the expanded `PackageSearchDialog`.
 *
 * Extracted so both surfaces agree on:
 *   - arch normalization (UI's canonical labels → the Debian-style
 *     names ict-pkgsvc indexes on)
 *   - what counts as a valid package name for the "+ Add …" escape hatch
 *   - group buckets (Base / Boot & kernel / Firmware / AI & Media (Intel)
 *     / ROS 2 / Other), so a user adding a package via the dialog sees
 *     it land in the same group when the inline chip list re-renders.
 *   - MiniSearch config so client-side reranking is identical.
 *
 * Kept as data + tiny pure functions — no React, no hooks — so both
 * components can import from here without a circular dep.
 */

// Backend package indices key on Debian-style arch names ('amd64',
// 'arm64', 'armhf'). The rest of the UI speaks the ICT canonical labels
// ('x86_64', 'aarch64', 'armv7hl'); translate here so callers don't
// have to care.
export const ARCH_MAP: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  armv7hl: 'armhf',
}

export function normalizeArch(arch: string): string {
  return ARCH_MAP[arch] ?? arch
}

// Package name grammar: begins with an alnum, then any of Debian's
// allowed name characters plus a couple of glob metacharacters so users
// can add wildcarded matches (apt install 'foo*'). Kept permissive —
// the backend rejects anything genuinely malformed at build time.
export const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+_.:*?[\]-]*$/

// Debounce window before firing a fetch on query/os/arch change. 200ms
// is the tail of "feels instant" but coalesces bursts from held-down
// keys.
export const DEBOUNCE_MS = 200

// Server cap for the fetch. The list is grouped client-side so ~100
// entries is plenty to populate every bucket without visibly truncating
// any.
export const SEARCH_LIMIT = 100

export type GroupKey =
  | 'Base'
  | 'Boot & kernel'
  | 'Firmware'
  | 'AI & Media (Intel)'
  | 'ROS 2'
  | 'Other'

// Prefix / exact classifiers per group. Each entry is checked in order;
// the first hit assigns the group. Kept as regex so we can express
// "starts with" and "equals" without a growing chain of if/else.
export const GROUP_RULES: Array<{ re: RegExp; group: GroupKey }> = [
  // AI & Media stack first — some Intel packages would otherwise match
  // the generic "linux-*" boot rule (intel-driver-* provides linux
  // compat shims).
  {
    re: /^(openvino|intel-oneapi-|libze|libigfx|intel-npu-|intel-driver-|intel-media-|librealsense)/,
    group: 'AI & Media (Intel)',
  },
  { re: /^ros-/, group: 'ROS 2' },
  {
    re: /^(linux-image|linux-headers|grub-|grub2-|systemd-boot|dracut|cryptsetup|efibootmgr)/,
    group: 'Boot & kernel',
  },
  // linux-firmware overlaps both "linux-" and "firmware" — send it to
  // Firmware.
  { re: /^(firmware-|linux-firmware)/, group: 'Firmware' },
  {
    re: /^(ubuntu-|apt$|bash$|sudo$|systemd$|systemd-|openssh-|debconf|debconf-|gnupg$|lsb-release$|software-properties-|debian-)/,
    group: 'Base',
  },
]

export function groupFor(name: string): GroupKey {
  for (const rule of GROUP_RULES) if (rule.re.test(name)) return rule.group
  return 'Other'
}

// MiniSearch options — both surfaces use the same reindex over each
// server response so relative ordering agrees.
export const MINISEARCH_OPTIONS = {
  fields: ['name', 'description', 'provides'] as string[],
  storeFields: [
    'name',
    'version',
    'description',
    'arch',
    'section',
    'repository',
    'type',
    'provides',
  ] as string[],
  searchOptions: {
    boost: { name: 3, description: 1, provides: 2 } as Record<string, number>,
    fuzzy: 0.2,
    prefix: true,
  },
} as const
