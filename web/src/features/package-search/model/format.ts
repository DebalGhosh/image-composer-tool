/**
 * Popcon formatting, the highlight regex and the selection toggle. Pure — no
 * React, no DOM. Extracted verbatim from PackageSearchDialog.tsx.
 */

/** Add or remove `name` from a selection list, preserving order. */
export function toggleValue(values: string[], name: string): string[] {
  return values.includes(name) ? values.filter((v) => v !== name) : [...values, name]
}

/**
 * Debian popcon install count as a compact label.
 *
 * Returns the EMPTY STRING for absent / zero / negative, not '0' — the caller
 * renders nothing rather than a misleading zero, because pkgsvc omits the field
 * for packages popcon has no data on, which is not the same as "nobody installs
 * it".
 */
export function formatInst(n: number | undefined): string {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k'
  return String(n)
}

/**
 * Popcon bar width as a percentage, LOG-scaled against an anchor of 100k
 * installs (Ubuntu noble's rough "well-installed" median). Values above the
 * anchor saturate; 0 renders an empty bar.
 *
 * Log scale rather than linear because install counts span five orders of
 * magnitude — linear would render everything except the top few packages as a
 * visually identical sliver.
 */
export function popconBarWidth(inst: number | undefined): number {
  if (!inst || inst <= 0) return 0
  const anchor = 100_000
  const w = Math.log1p(inst) / Math.log1p(anchor)
  return Math.min(1, w) * 100
}

/**
 * Split `text` into alternating plain / matched segments for the query tokens.
 *
 * Returns the raw split array: EVEN indices are plain text, ODD indices are
 * matches. That parity contract is what the renderer keys on, and it holds
 * because the regex has exactly one capture group.
 *
 * Tokens are split on whitespace so "machine learning" highlights both words
 * independently, and every token is regex-escaped — a query of `c++`, `lib.so`
 * or `a|b` matches literally instead of throwing or matching wrongly.
 *
 * Returns null when there is nothing to highlight, so the caller can render the
 * original string rather than wrapping every character in a span.
 */
export function highlightSegments(text: string, q: string): string[] | null {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  // Build a single regex OR of the tokens. Escape regex-y chars in each.
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp('(' + escaped.join('|') + ')', 'gi')
  return text.split(re)
}
