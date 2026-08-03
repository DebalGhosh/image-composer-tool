import { describe, it, expect } from 'vitest'
import { computeBuildGates } from './buildGates'
import { MAX_YAML_BYTES, type YamlValidity } from './validateYaml'

/**
 * The six reasons the Advanced tab may refuse a build.
 *
 * `canBuild` is a plain conjunction, so most of the value here is in the FLAGS:
 * each one drives a different piece of UI, and confusing two of them shows the
 * operator the wrong explanation for why the button is dead.
 */

const OK: YamlValidity = { ok: true, message: null, line: null, col: null }
const BAD: YamlValidity = {
  ok: false,
  message: 'Tabs are not allowed as indentation',
  line: 2,
  col: 1,
}

/** A buildable baseline; each test perturbs exactly one input. */
function gates(over: Partial<Parameters<typeof computeBuildGates>[0]> = {}) {
  return computeBuildGates({
    yaml: 'imageName: x',
    byteLen: 12,
    validity: OK,
    placeholderCount: 0,
    override: false,
    busy: false,
    seedBusy: false,
    ...over,
  })
}

describe('computeBuildGates', () => {
  it('permits a build when every gate is open', () => {
    const g = gates()
    expect(g).toEqual({
      empty: false,
      tooLarge: false,
      invalid: false,
      blockedByPlaceholders: false,
      canBuild: true,
    })
  })

  describe('empty', () => {
    it('is true for an empty buffer', () => {
      expect(gates({ yaml: '' }).empty).toBe(true)
    })

    it('is true for whitespace only — trim, not length', () => {
      expect(gates({ yaml: '   \n\t\n' }).empty).toBe(true)
    })

    it('blocks the build', () => {
      expect(gates({ yaml: '' }).canBuild).toBe(false)
    })
  })

  describe('tooLarge', () => {
    it('is false exactly AT the cap', () => {
      // `>` not `>=` — a template of exactly 200 KiB is allowed.
      expect(gates({ byteLen: MAX_YAML_BYTES }).tooLarge).toBe(false)
      expect(gates({ byteLen: MAX_YAML_BYTES }).canBuild).toBe(true)
    })

    it('is true one byte over', () => {
      expect(gates({ byteLen: MAX_YAML_BYTES + 1 }).tooLarge).toBe(true)
      expect(gates({ byteLen: MAX_YAML_BYTES + 1 }).canBuild).toBe(false)
    })
  })

  describe('invalid — the subtle one', () => {
    it('is true for a broken non-empty buffer', () => {
      expect(gates({ validity: BAD }).invalid).toBe(true)
    })

    it('is FALSE for an empty buffer even if validity says not-ok', () => {
      // THE GUARD THAT MATTERS. An empty buffer short-circuits to ok in
      // validateYaml, but if a future caller ever passed a not-ok validity with
      // empty text, `empty` must win: the operator who just cleared the editor
      // gets a quiet disabled button, not a syntax-error banner.
      const g = gates({ yaml: '', validity: BAD })
      expect(g.empty).toBe(true)
      expect(g.invalid).toBe(false)
      expect(g.canBuild).toBe(false)
    })

    it('blocks the build', () => {
      expect(gates({ validity: BAD }).canBuild).toBe(false)
    })
  })

  describe('blockedByPlaceholders', () => {
    it('is true while unreplaced tokens remain', () => {
      expect(gates({ placeholderCount: 3 }).blockedByPlaceholders).toBe(true)
    })

    it('is CLEARED by the override checkbox', () => {
      const g = gates({ placeholderCount: 3, override: true })
      expect(g.blockedByPlaceholders).toBe(false)
      expect(g.canBuild).toBe(true)
    })

    it('override on a buffer with no placeholders changes nothing', () => {
      expect(gates({ placeholderCount: 0, override: true }).canBuild).toBe(true)
    })

    it('override does NOT unblock the other gates', () => {
      // It is an override for placeholders specifically, not a force-build.
      expect(gates({ yaml: '', override: true }).canBuild).toBe(false)
      expect(gates({ validity: BAD, override: true }).canBuild).toBe(false)
      expect(
        gates({ byteLen: MAX_YAML_BYTES + 1, override: true }).canBuild,
      ).toBe(false)
    })
  })

  describe('the in-flight gates', () => {
    it('busy blocks the build without setting any flag', () => {
      const g = gates({ busy: true })
      expect(g.canBuild).toBe(false)
      // No banner for this one — the button just says "Starting…".
      expect(g.empty || g.tooLarge || g.invalid || g.blockedByPlaceholders).toBe(
        false,
      )
    })

    it('seedBusy blocks the build too', () => {
      // A seed fetch is about to replace the whole buffer; dispatching the old
      // one would build something the operator is no longer looking at.
      expect(gates({ seedBusy: true }).canBuild).toBe(false)
    })
  })

  it('reports every applicable flag at once rather than the first', () => {
    // The UI stacks banners, so an operator with a huge broken paste containing
    // placeholders sees all three reasons.
    const g = gates({
      byteLen: MAX_YAML_BYTES + 1,
      validity: BAD,
      placeholderCount: 2,
    })
    expect(g.tooLarge).toBe(true)
    expect(g.invalid).toBe(true)
    expect(g.blockedByPlaceholders).toBe(true)
    expect(g.canBuild).toBe(false)
  })
})
