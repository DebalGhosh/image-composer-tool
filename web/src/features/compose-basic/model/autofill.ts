import type { DropdownOption, Selection } from '@/store'

/**
 * Which cascade dimension should be auto-filled next, if any.
 *
 * PURE — no React, no store. Extracted from BasicPage's auto-fill effect in
 * FE-7c, where it was six near-identical `if` blocks that pushed the component
 * to complexity 23 and could not be tested without mounting the page.
 *
 * WHY AUTO-FILL AT ALL: when a dimension collapses to exactly one option there
 * is no choice to make, and expanding a dropdown to click its sole entry is pure
 * friction.
 *
 * ONE DIMENSION PER CALL, deliberately. The caller sets that field, which
 * schedules a re-render, which recomputes the options, which calls this again
 * for the next dimension. The chain terminates by itself the moment it reaches a
 * dimension with 0 or 2+ options, or one already set. Returning the whole chain
 * in one pass would mean computing downstream options against a selection the
 * store has not accepted yet.
 *
 * ⚠️ THE `enabled` PREDICATES TRACK EACH <Select>'s `disabled` PROP. The
 * invariant is one-directional and that is what matters: we must never auto-fill
 * a dimension the user would still see greyed out. Two rules are subtle:
 *   - `platform` opens when sku is set OR the vertical has NO sku dimension at
 *     all (`skus.length === 0`) — not merely when sku is falsy;
 *   - `imageType` opens when os is set AND (there is no kernel dimension OR
 *     kernel is set) — same shape, one level down.
 * Change a Select's `disabled` and you must revisit its rule here too.
 *
 * ONE KNOWN ASYMMETRY, PRE-EXISTING AND DELIBERATELY LEFT ALONE (recorded during
 * FE-7c, not introduced by it). `platform`'s rule here also requires `vertical`,
 * while the Platform <Select>'s `disabled` is only
 * `!selection.sku && opts.skus.length > 0`. They diverge in exactly one reachable
 * state: no vertical chosen AND no combination in the manifest carries a sku at
 * all — then the Select is interactive but this function still declines. The
 * direction is safe: auto-fill is STRICTER than the control, so the invariant
 * above holds; the cost is a missed convenience, not a wrong field. Aligning them
 * would be a behaviour change and belongs in its own commit.
 */

/** The cascade dimensions, in the order they must be filled. */
export type CascadeField =
  | 'vertical'
  | 'sku'
  | 'platform'
  | 'os'
  | 'kernel'
  | 'imageType'

/** The option lists cascadingOptions() produces, keyed by dimension. */
export interface CascadeOptions {
  verticals: DropdownOption[]
  skus: DropdownOption[]
  platforms: DropdownOption[]
  oses: DropdownOption[]
  kernels: DropdownOption[]
  imageTypes: DropdownOption[]
}

interface Rule {
  field: CascadeField
  options: (o: CascadeOptions) => DropdownOption[]
  /** True when the corresponding <Select> would be interactive. */
  enabled: (s: Selection, o: CascadeOptions) => boolean
}

/**
 * The cascade, top-down. Order is load-bearing: the first rule whose dimension
 * is unset, enabled, and single-optioned wins.
 */
const RULES: Rule[] = [
  {
    field: 'vertical',
    options: (o) => o.verticals,
    enabled: () => true,
  },
  {
    field: 'sku',
    options: (o) => o.skus,
    enabled: (s) => !!s.vertical,
  },
  {
    field: 'platform',
    options: (o) => o.platforms,
    // sku set, OR this vertical has no sku dimension at all.
    enabled: (s, o) => !!s.vertical && (!!s.sku || o.skus.length === 0),
  },
  {
    field: 'os',
    options: (o) => o.oses,
    enabled: (s) => !!s.platform,
  },
  {
    field: 'kernel',
    options: (o) => o.kernels,
    enabled: (s) => !!s.os,
  },
  {
    field: 'imageType',
    options: (o) => o.imageTypes,
    // os set, AND (no kernel dimension OR kernel picked).
    enabled: (s, o) => !!s.os && (o.kernels.length === 0 || !!s.kernel),
  },
]

/**
 * The next field to auto-fill and the value to set, or null when nothing
 * qualifies.
 */
export function nextAutoFill(
  selection: Selection,
  options: CascadeOptions,
): { field: CascadeField; value: string } | null {
  for (const rule of RULES) {
    if (selection[rule.field]) continue
    if (!rule.enabled(selection, options)) continue
    const opts = rule.options(options)
    if (opts.length !== 1) continue
    return { field: rule.field, value: opts[0].id }
  }
  return null
}
