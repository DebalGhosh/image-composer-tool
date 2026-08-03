/**
 * Static option tables for the Interactive composer. Pure data — no React.
 *
 * Kept top-level (as they were) so they do not reallocate per render.
 *
 * ⚠️ THESE TABLES ARE THE UI'S CONTRACT WITH THE BUILD ENGINE. A value here must
 * match what `internal/provider/` accepts: the `target.os` strings are the
 * provider `OsName` values (`ubuntu`, `debian`, `azure-linux`,
 * `edge-microvisor-toolkit`, `wind-river-elxr`, `redhat-compatible-distro`), not
 * the directory names (`azl`, `emt`, `elxr`, `rcd`). Silent drift here changes
 * what the UI offers and can dispatch a template the CLI rejects minutes later
 * inside the worker. options.test.ts pins every entry.
 *
 * Moved verbatim from InteractivePage.tsx; values unchanged.
 */
import type { ComboboxItem } from '@/components/controls/Combobox'
import type { Arch } from '@/features/partitions'

export const OS_OPTIONS: ComboboxItem[] = [
  { value: 'ubuntu', label: 'Ubuntu' },
  { value: 'debian', label: 'Debian' },
  { value: 'azure-linux', label: 'Azure Linux' },
  { value: 'edge-microvisor-toolkit', label: 'Edge Microvisor Toolkit' },
  { value: 'wind-river-elxr', label: 'Wind River eLxr' },
  { value: 'redhat-compatible-distro', label: 'Red Hat Compatible' },
]

/** OS → allowed distributions. Gates the dist Combobox. */
export const DIST_BY_OS: Record<string, ComboboxItem[]> = {
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

export const ARCH_OPTIONS: { value: Arch; label: string }[] = [
  { value: 'x86_64', label: 'x86_64' },
  { value: 'aarch64', label: 'aarch64' },
  { value: 'armv7hl', label: 'armv7hl' },
]

export const IMAGE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'raw', label: 'raw' },
  { value: 'img', label: 'img' },
  { value: 'iso', label: 'iso' },
  { value: 'wsl2', label: 'wsl2' },
]

/** Per-dist kernel version presets. Empty list ⇒ nothing to suggest. */
export const KERNEL_VERSIONS_BY_DIST: Record<string, string[]> = {
  ubuntu24: ['6.8', '6.11', '6.12', '7.0'],
  debian13: ['6.12'],
  azl3: ['6.6'],
  emt3: ['6.12'],
  elxr12: ['6.1', '6.12'],
  rcd10: ['6.12'],
}

/** Per-dist kernel package presets. Empty list ⇒ empty MultiCombobox. */
export const KERNEL_PACKAGES_BY_DIST: Record<string, string[]> = {
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
export const IMAGE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-_]*[a-zA-Z0-9])?$/
