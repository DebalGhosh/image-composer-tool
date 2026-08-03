import type { Manifest } from '@/api/types'

/**
 * Human-readable label for the seed-template dropdown, e.g.
 * `Industrial · AMR · Wildcat Lake · Ubuntu 24.04 · RT · ISO`.
 *
 * PURE — a function of (manifest, index). Extracted from AdvancedPage in FE-7d.
 *
 * Every id resolves through its display-name table with a `?? id` fallback, so an
 * id the manifest does not describe shows as the raw id rather than blank. A blank
 * segment in a `·`-joined label would read as a rendering bug.
 *
 * `.filter(Boolean)` drops the segments that legitimately do not apply — a
 * combination with no SKU, or a non-RT kernel — so the separators never double up.
 * That is also why `rt` is `'RT' | ''` rather than `'RT' | 'Standard'`: naming the
 * common case would add noise to every row.
 */
export function seedLabel(manifest: Manifest, i: number): string {
  const c = manifest.combinations[i]
  const v =
    manifest.verticals.find((o) => o.id === c.vertical)?.displayName ?? c.vertical
  const sku = c.sku
    ? manifest.skus.find((o) => o.id === c.sku)?.displayName ?? c.sku
    : ''
  const p =
    manifest.platforms.find((o) => o.id === c.platform)?.displayName ?? c.platform
  const os = manifest.targets.find((o) => o.id === c.os)?.displayName ?? c.os
  const rt = c.kernel === 'rt' ? 'RT' : ''
  return [v, sku, p, os, rt, c.imageType.toUpperCase()]
    .filter(Boolean)
    .join(' · ')
}
