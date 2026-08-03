import { describe, it, expect } from 'vitest'
import { formatBytes } from './bytes'

/**
 * Characterisation tests. Every expected value computed by hand from the
 * implementation; the surprising ones are pinned deliberately.
 */

describe('formatBytes', () => {
  it('prints raw bytes below 1024, with NO rounding', () => {
    // The B tier returns `v` untouched — the toFixed only applies above it.
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to KiB at exactly 1024', () => {
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
  })

  it('shows ONE decimal below 10 and NONE at or above it', () => {
    // toFixed(v >= 10 ? 0 : 1) — the boundary is exact.
    expect(formatBytes(1024 * 2)).toBe('2.0 KiB')
    expect(formatBytes(1024 * 9)).toBe('9.0 KiB')
    expect(formatBytes(1024 * 10)).toBe('10 KiB')
    expect(formatBytes(1024 * 999)).toBe('999 KiB')
  })

  it('formats the real artifact sizes from a live build', () => {
    // The two images worker-07 #18 actually published.
    expect(formatBytes(966_002_688)).toBe('921 MiB') // the ISO
    expect(formatBytes(271_590_101)).toBe('259 MiB') // minimal rootfs .img
    expect(formatBytes(12_134_336)).toBe('12 MiB') // vmlinuz
    expect(formatBytes(3893)).toBe('3.8 KiB') // UPLOAD-MANIFEST.txt
  })

  it('walks every tier', () => {
    const K = 1024
    expect(formatBytes(K)).toBe('1.0 KiB')
    expect(formatBytes(K ** 2)).toBe('1.0 MiB')
    expect(formatBytes(K ** 3)).toBe('1.0 GiB')
    expect(formatBytes(K ** 4)).toBe('1.0 TiB')
  })

  it('SATURATES at TiB rather than continuing to PiB', () => {
    // `i < units.length - 1` stops the loop. A corrupt size renders as a large
    // TiB figure instead of an unknown unit.
    const K = 1024
    expect(formatBytes(K ** 5)).toBe('1024 TiB')
    expect(formatBytes(K ** 6)).toBe('1048576 TiB')
  })

  it('rounds rather than truncating within a tier', () => {
    // 1536 B = 1.5 KiB exactly; 1996 B = 1.949… -> 1.9
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1996)).toBe('1.9 KiB')
    // 1024*9.96 = 10199 -> 9.96 KiB, still under 10 so one decimal, rounds to 10.0
    expect(formatBytes(10199)).toBe('10.0 KiB')
  })

  it('does not guard against negatives — they stay in the B tier', () => {
    // The loop condition is `v >= 1024`, so a negative never advances a tier.
    // Pinned as current behaviour: callers only pass server-reported sizes.
    expect(formatBytes(-5)).toBe('-5 B')
    expect(formatBytes(-1_000_000)).toBe('-1000000 B')
  })

  it('passes a fractional byte count straight through in the B tier', () => {
    expect(formatBytes(0.5)).toBe('0.5 B')
  })
})
