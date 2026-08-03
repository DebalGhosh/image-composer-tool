/**
 * Size arithmetic for the partition editor. Pure — no React, no DOM.
 *
 * ⚠️ These are MiB-based (1024) throughout, and that is not a style choice.
 * `.claude/YAML-INTEGRITY.md` names `internal/image/imagedisc/imagedisc.go:96-97`
 * as the AUTHORITY on unit semantics, which the front-end must match rather than
 * approximate: binary units and the bare shorthand are powers of two, the SI
 * forms are powers of ten. The parse below deliberately treats a bare number and
 * `M` identically, and tolerates the `B`/`iB` suffix, because that is what the
 * Go side accepts.
 *
 * Extracted verbatim from SegmentedPartitionEditor.tsx. Do not "improve" the
 * rounding: `parseSize(formatSize(x))` is lossy above 1024 MiB by design (see
 * size.test.ts), and templates round-trip through the YAML layer, not through
 * this display formatter.
 */

/**
 * Format MiB as a human-readable string.
 *
 * Tier boundaries and digit counts are exact and load-bearing for the UI's
 * column widths: MiB below 1024, then GiB with ONE decimal under 10 and ZERO at
 * or above it (so "9.5 GiB" but "10 GiB"), then TiB with two.
 */
export function formatSize(miB: number): string {
  if (miB < 1024) return `${miB} MiB`
  const gib = miB / 1024
  if (gib < 1024) {
    return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`
  }
  return `${(gib / 1024).toFixed(2)} TiB`
}

/**
 * Parse a human-typed size string back to MiB. Accepts:
 *   "100"          → 100 MiB   (bare number defaults to MiB)
 *   "100 MiB"      → 100 MiB
 *   "2G", "2 GiB"  → 2048 MiB
 *   "0.5 TiB"      → 524288 MiB
 * Case-insensitive; trailing "B"/"iB" tolerated (GB and GiB both work).
 * Returns null when the string doesn't parse (caller rolls back to previous
 * value on null).
 */
export function parseSize(raw: string): number | null {
  const s = raw.trim().toUpperCase()
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/.exec(s)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  const unit = m[2]
  // Everything scales to MiB (1024-based). Bare number = MiB. "K" = KiB
  // so 1024 K = 1 MiB → n/1024. G/T = ×1024, ×1024² respectively.
  switch (unit) {
    case '':
    case 'M':
      return Math.round(n)
    case 'K':
      return Math.max(0, Math.round(n / 1024))
    case 'G':
      return Math.round(n * 1024)
    case 'T':
      return Math.round(n * 1024 * 1024)
  }
  return null
}

/**
 * Clamp `n` into [lo, hi].
 *
 * Note the inverted-range branch: when hi < lo it returns `lo`, NOT `hi`. The
 * drag handler can compute an empty range when a partition is squeezed against
 * its neighbour's minimum, and biasing to the low bound is what keeps the left
 * partition at its floor instead of collapsing it.
 */
export function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(hi, Math.max(lo, n))
}
