import type { Combination, Manifest } from '@/api/types'
import type { Selection } from './types'

/**
 * The Basic tab's dependent-dropdown logic: which options are still reachable
 * given what the operator has already picked.
 *
 * PURE, and that is the point of the split — nothing here touches Zustand, React
 * or localStorage. It is a function of (manifest, selection), which makes it the
 * one part of the old store.ts that could be unit-tested without a store.
 *
 * The cascade order is vertical -> sku -> platform -> os -> kernel -> imageType,
 * matching the reset logic in the store's setSelection.
 */

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
