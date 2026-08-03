import { describe, it, expect } from 'vitest'
import { formatSize, parseSize, clamp } from './size'

/**
 * Characterisation tests for the partition size arithmetic.
 *
 * These functions were unexported and therefore untestable before FE-3. Every
 * expected value below was computed by hand from the implementation, and the
 * quirks are pinned deliberately — a refactor must not "fix" them.
 */

describe('formatSize', () => {
  it('uses MiB below 1024 with no decimals', () => {
    expect(formatSize(0)).toBe('0 MiB')
    expect(formatSize(1)).toBe('1 MiB')
    expect(formatSize(100)).toBe('100 MiB')
    expect(formatSize(1023)).toBe('1023 MiB')
  })

  it('switches to GiB at exactly 1024', () => {
    // The guard is `< 1024`, so 1024 is the first GiB value.
    expect(formatSize(1023)).toBe('1023 MiB')
    expect(formatSize(1024)).toBe('1.0 GiB')
  })

  it('shows ONE decimal below 10 GiB and ZERO at or above it', () => {
    // `gib >= 10 ? toFixed(0) : toFixed(1)` — the boundary is exact.
    expect(formatSize(1024 * 2)).toBe('2.0 GiB')
    expect(formatSize(1024 * 9.5)).toBe('9.5 GiB')
    expect(formatSize(1024 * 10)).toBe('10 GiB')
    expect(formatSize(1024 * 64)).toBe('64 GiB')
  })

  it('rounds rather than truncates within a tier', () => {
    // 1536 MiB = 1.5 GiB exactly.
    expect(formatSize(1536)).toBe('1.5 GiB')
    // 1500 MiB = 1.4648... -> toFixed(1) rounds to 1.5
    expect(formatSize(1500)).toBe('1.5 GiB')
    // 1400 MiB = 1.3672... -> 1.4
    expect(formatSize(1400)).toBe('1.4 GiB')
  })

  it('switches to TiB at 1024 GiB with two decimals', () => {
    const TIB = 1024 * 1024
    expect(formatSize(TIB - 1024)).toBe('1023 GiB')
    expect(formatSize(TIB)).toBe('1.00 TiB')
    expect(formatSize(TIB * 2)).toBe('2.00 TiB')
    expect(formatSize(TIB * 1.5)).toBe('1.50 TiB')
  })

  it('does not guard against negatives — they format as MiB', () => {
    // Pinned as current behaviour: -5 < 1024, so it takes the MiB branch.
    // Callers clamp before formatting; this function does not.
    expect(formatSize(-5)).toBe('-5 MiB')
  })

  it('passes fractional MiB straight through in the MiB tier', () => {
    // No rounding in the MiB branch — the raw number is interpolated.
    expect(formatSize(100.5)).toBe('100.5 MiB')
  })
})

describe('parseSize', () => {
  it('treats a bare number as MiB', () => {
    expect(parseSize('100')).toBe(100)
    expect(parseSize('0')).toBe(0)
  })

  it('accepts every documented unit form', () => {
    expect(parseSize('100 MiB')).toBe(100)
    expect(parseSize('100M')).toBe(100)
    expect(parseSize('100MB')).toBe(100)
    expect(parseSize('2G')).toBe(2048)
    expect(parseSize('2 GiB')).toBe(2048)
    expect(parseSize('2GB')).toBe(2048)
    expect(parseSize('0.5 TiB')).toBe(524288)
    expect(parseSize('1T')).toBe(1048576)
  })

  it('divides for K — 1024 KiB is 1 MiB', () => {
    expect(parseSize('1024K')).toBe(1)
    expect(parseSize('2048 KiB')).toBe(2)
  })

  it('floors sub-1-MiB K values to 0 via Math.max(0, ...)', () => {
    // Math.round(1/1024) = 0. The Math.max(0, ...) is belt-and-braces for a
        // negative that the regex already rejects, but the 0 result is real and
    // callers must tolerate it.
    expect(parseSize('1K')).toBe(0)
    expect(parseSize('511K')).toBe(0)
    expect(parseSize('512K')).toBe(1) // rounds up at the halfway point
  })

  it('is case-insensitive', () => {
    expect(parseSize('2g')).toBe(2048)
    expect(parseSize('2gib')).toBe(2048)
    expect(parseSize('100mib')).toBe(100)
  })

  it('tolerates whitespace around the number and unit', () => {
    expect(parseSize('  2 G  ')).toBe(2048)
    expect(parseSize('2   GiB')).toBe(2048)
  })

  it('rounds to whole MiB', () => {
    expect(parseSize('1.5G')).toBe(1536)
    expect(parseSize('100.4')).toBe(100)
    expect(parseSize('100.6')).toBe(101)
  })

  it('returns null for anything it cannot parse', () => {
    for (const bad of [
      '',
      '   ',
      'abc',
      'M',
      '100X',
      '100 PiB',
      '1e3',
      '--5',
      '1,024',
      '1.2.3',
      '0x10',
    ]) {
      expect(parseSize(bad), bad).toBeNull()
    }
  })

  it('rejects a leading minus at the regex, so negatives never reach the math', () => {
    expect(parseSize('-5')).toBeNull()
    expect(parseSize('-5G')).toBeNull()
  })

  it('accepts a bare "B" suffix because the unit group is optional', () => {
    // /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/ — with no K/M/G/T the empty unit
    // branch runs, so "100B" is 100 MiB. Surprising but current behaviour.
    expect(parseSize('100B')).toBe(100)
    expect(parseSize('100iB')).toBe(100)
  })
})

describe('parseSize / formatSize round trip', () => {
  it('round-trips exactly in the MiB tier', () => {
    for (const n of [0, 1, 100, 512, 1023]) {
      expect(parseSize(formatSize(n))).toBe(n)
    }
  })

  it('is LOSSY above 1024 MiB — the display formatter is not a serialiser', () => {
    // formatSize(1500) is "1.5 GiB", which parses back to 1536, not 1500.
    // Pinned so nobody wires the display value into a save path. The YAML layer
    // carries exact sizes; this pair is for the UI only.
    expect(formatSize(1500)).toBe('1.5 GiB')
    expect(parseSize('1.5 GiB')).toBe(1536)
    expect(parseSize(formatSize(1500))).not.toBe(1500)
  })

  it('round-trips exact GiB multiples', () => {
    for (const gib of [1, 2, 4, 8, 16, 64]) {
      expect(parseSize(formatSize(gib * 1024))).toBe(gib * 1024)
    }
  })
})

describe('clamp', () => {
  it('clamps into range', () => {
    expect(clamp(5, 1, 10)).toBe(5)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(99, 1, 10)).toBe(10)
    expect(clamp(1, 1, 10)).toBe(1)
    expect(clamp(10, 1, 10)).toBe(10)
  })

  it('returns LO — not hi — for an inverted range', () => {
    // Load-bearing: the drag handler computes an empty range when a partition is
    // squeezed against its neighbour's minimum, and biasing low keeps it at its
    // floor rather than collapsing it.
    expect(clamp(5, 10, 1)).toBe(10)
    expect(clamp(0, 10, 1)).toBe(10)
    expect(clamp(100, 10, 1)).toBe(10)
  })

  it('handles negatives and equal bounds', () => {
    expect(clamp(-5, -10, -1)).toBe(-5)
    expect(clamp(-50, -10, -1)).toBe(-10)
    expect(clamp(7, 3, 3)).toBe(3)
  })
})
