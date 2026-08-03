/**
 * Artifact size formatting. Pure — no React, no DOM.
 *
 * Extracted verbatim from BuildView.tsx, where it was unexported and therefore
 * untestable. The published ISOs are ~1 GB and the intermediate rootfs ~270 MB,
 * so the GiB/MiB tiers are the ones that actually render in the Artifacts card.
 */

/**
 * Format a byte count with binary (1024) units.
 *
 * Two details are load-bearing for the Artifacts table's column width:
 *   - The B tier prints the RAW value with no rounding at all — `formatBytes(0)`
 *     is `'0 B'`, and a fractional byte count would print its fraction. Bytes
 *     are always integers in practice, so this never surfaces.
 *   - Above B, one decimal below 10 and none at or above it: `'9.4 MiB'` but
 *     `'10 MiB'`. That keeps the rendered string to a predictable width.
 *
 * Saturates at TiB rather than continuing to PiB — no ICT artifact approaches it,
 * and an unbounded unit list would let a corrupt size render as nonsense.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}
