import { describe, it, expect } from 'vitest'
import { seedLabel } from './seedLabel'
import type { Manifest } from '@/api/types'

/**
 * The seed-template dropdown's label. Joined with ` · `, so the interesting
 * behaviour is which segments get dropped and what happens when an id has no
 * display name.
 */

function manifest(
  combos: Partial<Manifest['combinations'][number]>[],
): Manifest {
  return {
    combinations: combos as Manifest['combinations'],
    verticals: [{ id: 'industrial', displayName: 'Industrial' }],
    skus: [{ id: 'amr', displayName: 'AMR' }],
    platforms: [{ id: 'wcl', displayName: 'Wildcat Lake' }],
    targets: [{ id: 'ubuntu24', displayName: 'Ubuntu 24.04' }],
  } as Manifest
}

describe('seedLabel', () => {
  it('joins every resolved segment with a middle dot', () => {
    const m = manifest([
      {
        vertical: 'industrial',
        sku: 'amr',
        platform: 'wcl',
        os: 'ubuntu24',
        kernel: 'rt',
        imageType: 'iso',
      },
    ])
    expect(seedLabel(m, 0)).toBe(
      'Industrial · AMR · Wildcat Lake · Ubuntu 24.04 · RT · ISO',
    )
  })

  it('DROPS the sku segment when the combination has none', () => {
    // Not an empty segment: `.filter(Boolean)` removes it so the separators do
    // not double up into ' ·  · '.
    const m = manifest([
      {
        vertical: 'industrial',
        platform: 'wcl',
        os: 'ubuntu24',
        imageType: 'iso',
      },
    ])
    expect(seedLabel(m, 0)).toBe('Industrial · Wildcat Lake · Ubuntu 24.04 · ISO')
    expect(seedLabel(m, 0)).not.toContain('·  ·')
  })

  it('DROPS the kernel segment for a non-RT kernel', () => {
    // 'standard' is the common case; naming it would add noise to every row.
    const m = manifest([
      {
        vertical: 'industrial',
        platform: 'wcl',
        os: 'ubuntu24',
        kernel: 'standard',
        imageType: 'iso',
      },
    ])
    expect(seedLabel(m, 0)).toBe('Industrial · Wildcat Lake · Ubuntu 24.04 · ISO')
    expect(seedLabel(m, 0)).not.toContain('Standard')
  })

  it('shows RT only for kernel === "rt" exactly', () => {
    const m = manifest([
      { vertical: 'v', platform: 'p', os: 'o', kernel: 'RT', imageType: 'iso' },
    ])
    // Case-sensitive: 'RT' is not 'rt', so the segment drops.
    expect(seedLabel(m, 0)).not.toContain('RT ·')
  })

  it('UPPER-CASES the image type', () => {
    const m = manifest([
      { vertical: 'v', platform: 'p', os: 'o', imageType: 'qcow2' },
    ])
    expect(seedLabel(m, 0)).toContain('QCOW2')
  })

  describe('display-name fallbacks', () => {
    it('falls back to the raw id for every dimension', () => {
      // A blank segment in a dot-joined label reads as a rendering bug, so an
      // undescribed id shows as itself.
      const m = manifest([
        {
          vertical: 'unlisted-v',
          sku: 'unlisted-s',
          platform: 'unlisted-p',
          os: 'unlisted-o',
          imageType: 'raw',
        },
      ])
      expect(seedLabel(m, 0)).toBe(
        'unlisted-v · unlisted-s · unlisted-p · unlisted-o · RAW',
      )
    })

    it('resolves some segments and falls back on others in one label', () => {
      const m = manifest([
        {
          vertical: 'industrial',
          platform: 'mystery-board',
          os: 'ubuntu24',
          imageType: 'iso',
        },
      ])
      expect(seedLabel(m, 0)).toBe(
        'Industrial · mystery-board · Ubuntu 24.04 · ISO',
      )
    })
  })

  it('labels by INDEX, so it tracks the manifest order', () => {
    const m = manifest([
      { vertical: 'industrial', platform: 'wcl', os: 'ubuntu24', imageType: 'iso' },
      { vertical: 'industrial', platform: 'wcl', os: 'ubuntu24', imageType: 'raw' },
    ])
    expect(seedLabel(m, 0)).toContain('ISO')
    expect(seedLabel(m, 1)).toContain('RAW')
  })
})
