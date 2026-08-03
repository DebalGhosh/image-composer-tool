import { describe, it, expect } from 'vitest'
import { cascadingOptions } from './cascade'
import type { Selection } from './types'
import type { Manifest } from '@/api/types'

/**
 * The Basic tab's dependent dropdowns. Pure, so it tests directly — which is
 * most of the reason FE-7b pulled it out of store.ts.
 *
 * The behaviours worth pinning are the ones a reader would guess wrong:
 *   - options are filtered ONLY by upstream selections, never downstream;
 *   - the kernel dimension is OPTIONAL, and when no combination carries one, it
 *     drops out of the imageType filter entirely rather than filtering on '';
 *   - `matched` coerces absent sku/kernel to '' before comparing, so a
 *     combination with no sku matches a selection with an empty sku;
 *   - order is first-seen in the manifest, not alphabetical;
 *   - a missing displayName falls back to the raw id rather than rendering blank.
 */

function manifest(combos: Partial<Manifest['combinations'][number]>[]): Manifest {
  return {
    combinations: combos as Manifest['combinations'],
    verticals: [
      { id: 'industrial', displayName: 'Industrial' },
      { id: 'retail', displayName: 'Retail' },
    ],
    skus: [{ id: 'amr', displayName: 'AMR' }],
    platforms: [{ id: 'wcl', displayName: 'Wildcat Lake' }],
    targets: [{ id: 'ubuntu24', displayName: 'Ubuntu 24.04' }],
  } as Manifest
}

const empty: Selection = {
  vertical: '',
  sku: '',
  platform: '',
  os: '',
  kernel: '',
  imageType: '',
}

describe('cascadingOptions', () => {
  describe('filtering by upstream selections', () => {
    const m = manifest([
      { vertical: 'industrial', sku: 'amr', platform: 'wcl', os: 'ubuntu24', imageType: 'iso' },
      { vertical: 'retail', sku: 'dv', platform: 'arl', os: 'debian13', imageType: 'raw' },
    ])

    it('offers every vertical when nothing is selected', () => {
      const out = cascadingOptions(m, empty)
      expect(out.verticals.map((v) => v.id)).toEqual(['industrial', 'retail'])
    })

    it('offers ALL skus when no vertical is chosen — an empty filter matches everything', () => {
      // `!v || …` in distinct() treats an empty filter value as "no constraint".
      const out = cascadingOptions(m, empty)
      expect(out.skus.map((s) => s.id)).toEqual(['amr', 'dv'])
    })

    it('narrows skus once a vertical is chosen', () => {
      const out = cascadingOptions(m, { ...empty, vertical: 'industrial' })
      expect(out.skus.map((s) => s.id)).toEqual(['amr'])
    })

    it('narrows platforms by vertical AND sku', () => {
      const out = cascadingOptions(m, { ...empty, vertical: 'retail', sku: 'dv' })
      expect(out.platforms.map((p) => p.id)).toEqual(['arl'])
    })

    it('returns nothing downstream when the upstream selection matches no row', () => {
      const out = cascadingOptions(m, { ...empty, vertical: 'industrial', sku: 'dv' })
      expect(out.platforms).toEqual([])
      expect(out.oses).toEqual([])
    })

    it('does NOT let a downstream selection filter an upstream list', () => {
      // Selecting an imageType must not shrink the vertical dropdown.
      const out = cascadingOptions(m, { ...empty, imageType: 'iso' })
      expect(out.verticals.map((v) => v.id)).toEqual(['industrial', 'retail'])
    })
  })

  describe('labels', () => {
    const m = manifest([
      { vertical: 'industrial', sku: 'amr', platform: 'wcl', os: 'ubuntu24', imageType: 'iso' },
    ])

    it('resolves displayName from the matching option list', () => {
      const out = cascadingOptions(m, empty)
      expect(out.verticals[0]).toEqual({ id: 'industrial', label: 'Industrial' })
      expect(out.skus[0].label).toBe('AMR')
      expect(out.platforms[0].label).toBe('Wildcat Lake')
      expect(out.oses[0].label).toBe('Ubuntu 24.04')
    })

    it('falls back to the raw id when no displayName exists', () => {
      // Better a machine id than a blank dropdown row.
      const m2 = manifest([
        { vertical: 'unlisted', platform: 'wcl', os: 'ubuntu24', imageType: 'iso' },
      ])
      const out = cascadingOptions(m2, empty)
      expect(out.verticals[0]).toEqual({ id: 'unlisted', label: 'unlisted' })
    })

    it('UPPER-CASES image types', () => {
      const out = cascadingOptions(m, empty)
      expect(out.imageTypes[0]).toEqual({ id: 'iso', label: 'ISO' })
    })

    it('uses a hard-coded table for kernel labels', () => {
      const m2 = manifest([
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'rt', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'standard', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'lowlatency', imageType: 'iso' },
      ])
      const out = cascadingOptions(m2, { ...empty, vertical: 'v', platform: 'p', os: 'o' })
      expect(out.kernels).toEqual([
        { id: 'rt', label: 'Real-Time' },
        { id: 'standard', label: 'Standard' },
        // Not in the table -> raw id, same fallback as displayName.
        { id: 'lowlatency', label: 'lowlatency' },
      ])
    })
  })

  describe('the kernel dimension is OPTIONAL', () => {
    it('yields no kernels when no combination carries one', () => {
      // The UI omits the selector entirely in this case, so RT-vs-standard is
      // surfaced only where the metadata actually offers a choice.
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso' },
      ])
      const out = cascadingOptions(m, { ...empty, vertical: 'v', platform: 'p', os: 'o' })
      expect(out.kernels).toEqual([])
    })

    it('DROPS kernel from the imageType filter when no kernels exist', () => {
      // With `selection.kernel` unset this is indistinguishable from including
      // it — distinct()'s `!v ||` makes an empty filter value a no-op. Kept as
      // the ordinary case; the test below is the one that pins the spread.
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'raw' },
      ])
      const out = cascadingOptions(m, { ...empty, vertical: 'v', platform: 'p', os: 'o' })
      expect(out.imageTypes.map((i) => i.id)).toEqual(['iso', 'raw'])
    })

    it('ignores a STALE kernel selection when the new combinations offer none', () => {
      // THE ONLY CASE THAT DISTINGUISHES the conditional spread from an
      // unconditional `kernel: selection.kernel`, found by mutation-testing:
      // both forms agree whenever selection.kernel is '' (the `!v` escape), so
      // the divergence needs a TRUTHY stale kernel against a kernel-less
      // combination set.
      //
      // Reachable in the app: the operator picks a kernel, then the manifest is
      // refetched — or they switch to a vertical whose rows carry no kernel at
      // all. `setSelection` only resets fields DOWNSTREAM of the one that
      // changed, so an upstream kernel can outlive the rows that offered it.
      //
      // With the spread, kernel drops out of the filter and imageTypes are
      // still offered. Without it, the filter compares 'rt' against undefined,
      // no row matches, and the operator sees an EMPTY Image Type dropdown with
      // no way to understand why.
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'raw' },
      ])
      const stale = {
        ...empty,
        vertical: 'v',
        platform: 'p',
        os: 'o',
        kernel: 'rt', // no combination above has a kernel
      }
      const out = cascadingOptions(m, stale)
      expect(out.kernels).toEqual([])
      expect(out.imageTypes.map((i) => i.id)).toEqual(['iso', 'raw'])
    })

    it('APPLIES the kernel filter to imageTypes once kernels exist', () => {
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'rt', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'standard', imageType: 'raw' },
      ])
      const sel = { ...empty, vertical: 'v', platform: 'p', os: 'o', kernel: 'rt' }
      const out = cascadingOptions(m, sel)
      expect(out.imageTypes.map((i) => i.id)).toEqual(['iso'])
    })

    it('offers BOTH imageTypes while kernels exist but none is picked yet', () => {
      // kernel is '' so the spread-in filter is a no-op constraint.
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'rt', imageType: 'iso' },
        { vertical: 'v', platform: 'p', os: 'o', kernel: 'standard', imageType: 'raw' },
      ])
      const out = cascadingOptions(m, { ...empty, vertical: 'v', platform: 'p', os: 'o' })
      expect(out.imageTypes.map((i) => i.id)).toEqual(['iso', 'raw'])
    })
  })

  describe('matched', () => {
    it('is null until every dimension is selected', () => {
      const m = manifest([
        { vertical: 'v', sku: 's', platform: 'p', os: 'o', imageType: 'iso', template: 'a.yml' },
      ])
      expect(cascadingOptions(m, empty).matched).toBeNull()
      expect(
        cascadingOptions(m, { ...empty, vertical: 'v', sku: 's', platform: 'p' }).matched,
      ).toBeNull()
    })

    it('matches a combination with NO sku against an empty sku selection', () => {
      // `(x.sku || '') === selection.sku` — an absent sku is coerced, so the
      // row is reachable rather than permanently unmatchable.
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso', template: 'a.yml' },
      ])
      const sel = { ...empty, vertical: 'v', platform: 'p', os: 'o', imageType: 'iso' }
      expect(cascadingOptions(m, sel).matched?.template).toBe('a.yml')
    })

    it('matches a combination with NO kernel against an empty kernel selection', () => {
      const m = manifest([
        { vertical: 'v', sku: 's', platform: 'p', os: 'o', imageType: 'iso', template: 'b.yml' },
      ])
      const sel = {
        ...empty,
        vertical: 'v',
        sku: 's',
        platform: 'p',
        os: 'o',
        imageType: 'iso',
      }
      expect(cascadingOptions(m, sel).matched?.template).toBe('b.yml')
    })

    it('does NOT match when the selection carries a kernel the combination lacks', () => {
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso', template: 'a.yml' },
      ])
      const sel = {
        ...empty,
        vertical: 'v',
        platform: 'p',
        os: 'o',
        kernel: 'rt',
        imageType: 'iso',
      }
      expect(cascadingOptions(m, sel).matched).toBeNull()
    })

    it('returns the FIRST match when the manifest holds duplicates', () => {
      const m = manifest([
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso', template: 'first.yml' },
        { vertical: 'v', platform: 'p', os: 'o', imageType: 'iso', template: 'second.yml' },
      ])
      const sel = { ...empty, vertical: 'v', platform: 'p', os: 'o', imageType: 'iso' }
      expect(cascadingOptions(m, sel).matched?.template).toBe('first.yml')
    })
  })

  describe('ordering and de-duplication', () => {
    it('preserves first-seen manifest order, NOT alphabetical order', () => {
      const m = manifest([
        { vertical: 'zebra', platform: 'p', os: 'o', imageType: 'iso' },
        { vertical: 'alpha', platform: 'p', os: 'o', imageType: 'iso' },
      ])
      expect(cascadingOptions(m, empty).verticals.map((v) => v.id)).toEqual([
        'zebra',
        'alpha',
      ])
    })

    it('de-duplicates ids that appear in many combinations', () => {
      const m = manifest([
        { vertical: 'v', platform: 'p1', os: 'o', imageType: 'iso' },
        { vertical: 'v', platform: 'p2', os: 'o', imageType: 'raw' },
        { vertical: 'v', platform: 'p3', os: 'o', imageType: 'iso' },
      ])
      expect(cascadingOptions(m, empty).verticals.map((v) => v.id)).toEqual(['v'])
      expect(cascadingOptions(m, empty).imageTypes.map((i) => i.id)).toEqual([
        'iso',
        'raw',
      ])
    })

    it('skips falsy field values rather than emitting an empty option', () => {
      // `c[field] &&` — a combination with sku: '' contributes no sku row, so
      // the dropdown never shows a blank entry.
      const m = manifest([
        { vertical: 'v', sku: '', platform: 'p', os: 'o', imageType: 'iso' },
      ])
      expect(cascadingOptions(m, empty).skus).toEqual([])
    })
  })

  it('handles an empty manifest without throwing', () => {
    const out = cascadingOptions(manifest([]), empty)
    expect(out.verticals).toEqual([])
    expect(out.imageTypes).toEqual([])
    expect(out.matched).toBeNull()
  })
})
