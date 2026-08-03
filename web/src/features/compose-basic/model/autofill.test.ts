import { describe, it, expect } from 'vitest'
import { nextAutoFill, type CascadeOptions } from './autofill'
import type { Selection } from '@/store'

/**
 * CHARACTERISATION tests for the auto-fill cascade, taken from BasicPage's
 * six-branch effect before FE-7c turned it into a table.
 *
 * The behaviours that matter are the ORDER (top-down, one per call) and the two
 * non-obvious enabling gates. Both gates exist to mirror a <Select>'s `disabled`
 * prop; auto-filling a dimension the user sees greyed out would set a field they
 * cannot then change without backing all the way up the cascade.
 */

const none: Selection = {
  vertical: '',
  sku: '',
  platform: '',
  os: '',
  kernel: '',
  imageType: '',
}

/** Build an options set; anything unspecified is empty. */
function opts(over: Partial<Record<keyof CascadeOptions, string[]>> = {}): CascadeOptions {
  const lift = (ids?: string[]) => (ids ?? []).map((id) => ({ id, label: id }))
  return {
    verticals: lift(over.verticals),
    skus: lift(over.skus),
    platforms: lift(over.platforms),
    oses: lift(over.oses),
    kernels: lift(over.kernels),
    imageTypes: lift(over.imageTypes),
  }
}

describe('nextAutoFill', () => {
  describe('the single-option rule', () => {
    it('fills a dimension that has exactly one option', () => {
      expect(nextAutoFill(none, opts({ verticals: ['industrial'] }))).toEqual({
        field: 'vertical',
        value: 'industrial',
      })
    })

    it('does NOT fill when there are two or more options', () => {
      expect(nextAutoFill(none, opts({ verticals: ['a', 'b'] }))).toBeNull()
    })

    it('does NOT fill when there are no options', () => {
      expect(nextAutoFill(none, opts({ verticals: [] }))).toBeNull()
    })

    it('does NOT re-fill a dimension the user already set', () => {
      const sel = { ...none, vertical: 'retail' }
      // industrial is the sole option but vertical is taken; the cascade moves
      // on rather than overwriting the user's pick.
      expect(nextAutoFill(sel, opts({ verticals: ['industrial'] }))).toBeNull()
    })
  })

  describe('ordering — one dimension per call, top-down', () => {
    it('returns the UPSTREAM dimension when several are fillable', () => {
      // Both vertical and os are single-optioned; vertical must win, because
      // setting it recomputes everything downstream.
      //
      // ⚠️ `platform` IS PRE-SET AND THAT IS THE WHOLE POINT OF THIS FIXTURE.
      // Without it, os's gate is closed, only one candidate exists, and the test
      // passes under ANY rule order — which is exactly how it read before
      // mutation-testing caught that reversing RULES broke nothing.
      const o = opts({ verticals: ['v'], oses: ['o'] })
      const sel = { ...none, platform: 'p' }
      expect(nextAutoFill(sel, o)?.field).toBe('vertical')
    })

    it('walks the full chain across successive calls', () => {
      // Simulates the effect's re-render loop: set the field, call again.
      const o = opts({
        verticals: ['v'],
        skus: ['s'],
        platforms: ['p'],
        oses: ['o'],
        kernels: ['k'],
        imageTypes: ['i'],
      })
      const sel: Selection = { ...none }
      const order: string[] = []
      for (let i = 0; i < 10; i++) {
        const next = nextAutoFill(sel, o)
        if (!next) break
        order.push(next.field)
        sel[next.field] = next.value
      }
      expect(order).toEqual([
        'vertical',
        'sku',
        'platform',
        'os',
        'kernel',
        'imageType',
      ])
      // And it terminates rather than looping forever.
      expect(nextAutoFill(sel, o)).toBeNull()
    })

    it('stops at the first dimension with a real choice', () => {
      const o = opts({ verticals: ['v'], skus: ['s1', 's2'], platforms: ['p'] })
      const sel = { ...none, vertical: 'v' }
      // sku has two options -> no auto-fill. Platform is single-optioned but
      // its gate is not open, so nothing happens at all: the user must pick.
      expect(nextAutoFill(sel, o)).toBeNull()
    })
  })

  describe('the platform gate — set sku OR no sku dimension at all', () => {
    it('does NOT fill platform while an unset sku dimension exists', () => {
      const sel = { ...none, vertical: 'v' }
      const o = opts({ skus: ['s1', 's2'], platforms: ['p'] })
      expect(nextAutoFill(sel, o)).toBeNull()
    })

    it('DOES fill platform when the vertical has no sku dimension', () => {
      // skus is EMPTY, not merely unselected. The <Select> is hidden/disabled
      // in this case, so platform is the next live control.
      const sel = { ...none, vertical: 'v' }
      const o = opts({ skus: [], platforms: ['p'] })
      expect(nextAutoFill(sel, o)).toEqual({ field: 'platform', value: 'p' })
    })

    it('DOES fill platform once sku is set', () => {
      const sel = { ...none, vertical: 'v', sku: 's' }
      const o = opts({ skus: ['s'], platforms: ['p'] })
      expect(nextAutoFill(sel, o)).toEqual({ field: 'platform', value: 'p' })
    })

    it('does NOT fill platform when vertical is still unset', () => {
      // THE ONE ASYMMETRY WITH THE <Select>, pinned so it cannot drift
      // unnoticed. In this exact state — no vertical AND no combination in the
      // manifest carries a sku — the Platform Select's `disabled` evaluates to
      // false, so the control IS interactive, yet this function declines.
      //
      // The direction is what makes it safe: auto-fill is STRICTER than the
      // control, so the invariant "never fill something the user sees greyed
      // out" still holds. Aligning them is a behaviour change and belongs in its
      // own commit; see the note in autofill.ts.
      const o = opts({ skus: [], platforms: ['p'] })
      expect(nextAutoFill(none, o)).toBeNull()
    })
  })

  describe('the imageType gate — os set AND (no kernel dimension OR kernel set)', () => {
    it('does NOT fill imageType while an unset kernel dimension exists', () => {
      // The bug this gate prevents: picking the image type before the kernel
      // that constrains which image types are even available.
      const sel = { ...none, os: 'o' }
      const o = opts({ kernels: ['rt', 'standard'], imageTypes: ['iso'] })
      expect(nextAutoFill(sel, o)).toBeNull()
    })

    it('DOES fill imageType when there is no kernel dimension', () => {
      const sel = { ...none, os: 'o' }
      const o = opts({ kernels: [], imageTypes: ['iso'] })
      expect(nextAutoFill(sel, o)).toEqual({ field: 'imageType', value: 'iso' })
    })

    it('DOES fill imageType once kernel is set', () => {
      const sel = { ...none, os: 'o', kernel: 'rt' }
      const o = opts({ kernels: ['rt'], imageTypes: ['iso'] })
      expect(nextAutoFill(sel, o)).toEqual({ field: 'imageType', value: 'iso' })
    })

    it('does NOT fill imageType when os is unset', () => {
      const o = opts({ kernels: [], imageTypes: ['iso'] })
      expect(nextAutoFill(none, o)).toBeNull()
    })
  })

  describe('gates on the simpler dimensions', () => {
    it('sku needs vertical', () => {
      expect(nextAutoFill(none, opts({ skus: ['s'] }))).toBeNull()
      expect(
        nextAutoFill({ ...none, vertical: 'v' }, opts({ skus: ['s'] })),
      ).toEqual({ field: 'sku', value: 's' })
    })

    it('os needs platform', () => {
      expect(nextAutoFill(none, opts({ oses: ['o'] }))).toBeNull()
      expect(
        nextAutoFill({ ...none, platform: 'p' }, opts({ oses: ['o'] })),
      ).toEqual({ field: 'os', value: 'o' })
    })

    it('kernel needs os', () => {
      expect(nextAutoFill(none, opts({ kernels: ['k'] }))).toBeNull()
      expect(
        nextAutoFill({ ...none, os: 'o' }, opts({ kernels: ['k'] })),
      ).toEqual({ field: 'kernel', value: 'k' })
    })

    it('vertical needs nothing — it is the root', () => {
      expect(nextAutoFill(none, opts({ verticals: ['v'] }))?.field).toBe(
        'vertical',
      )
    })
  })

  it('returns null for a fully empty options set', () => {
    expect(nextAutoFill(none, opts())).toBeNull()
  })

  it('returns null once every dimension is selected', () => {
    const full: Selection = {
      vertical: 'v',
      sku: 's',
      platform: 'p',
      os: 'o',
      kernel: 'k',
      imageType: 'i',
    }
    const o = opts({
      verticals: ['v'],
      skus: ['s'],
      platforms: ['p'],
      oses: ['o'],
      kernels: ['k'],
      imageTypes: ['i'],
    })
    expect(nextAutoFill(full, o)).toBeNull()
  })
})
