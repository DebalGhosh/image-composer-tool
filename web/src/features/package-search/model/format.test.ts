import { describe, it, expect } from 'vitest'
import { toggleValue, formatInst, popconBarWidth, highlightSegments } from './format'

describe('toggleValue', () => {
  it('adds when absent, appending to the end', () => {
    expect(toggleValue([], 'apt')).toEqual(['apt'])
    expect(toggleValue(['vim'], 'apt')).toEqual(['vim', 'apt'])
  })

  it('removes when present, preserving the order of the rest', () => {
    expect(toggleValue(['vim', 'apt', 'curl'], 'apt')).toEqual(['vim', 'curl'])
  })

  it('does not mutate the input', () => {
    const v = ['vim']
    toggleValue(v, 'apt')
    expect(v).toEqual(['vim'])
  })

  it('removes ALL duplicates if the list somehow holds them', () => {
    // filter, not findIndex+splice — so a list that already contains a
    // duplicate is fully cleaned rather than left with one copy.
    expect(toggleValue(['apt', 'vim', 'apt'], 'apt')).toEqual(['vim'])
  })
})

describe('formatInst', () => {
  it('returns the EMPTY STRING for absent, zero or negative', () => {
    // Not '0': pkgsvc omits the field for packages popcon has no data on, which
    // is different from "nobody installs it". The caller renders nothing.
    expect(formatInst(undefined)).toBe('')
    expect(formatInst(0)).toBe('')
    expect(formatInst(-5)).toBe('')
  })

  it('prints small counts verbatim', () => {
    expect(formatInst(1)).toBe('1')
    expect(formatInst(999)).toBe('999')
  })

  it('switches to k at 1000, with NO decimals', () => {
    expect(formatInst(1_000)).toBe('1k')
    expect(formatInst(1_500)).toBe('2k') // toFixed(0) rounds
    expect(formatInst(1_400)).toBe('1k')
    expect(formatInst(999_999)).toBe('1000k') // still k below 1M
  })

  it('switches to M at 1_000_000, with ONE decimal', () => {
    expect(formatInst(1_000_000)).toBe('1.0M')
    expect(formatInst(2_500_000)).toBe('2.5M')
    expect(formatInst(12_340_000)).toBe('12.3M')
  })
})

describe('popconBarWidth', () => {
  it('is 0 for absent, zero or negative', () => {
    expect(popconBarWidth(undefined)).toBe(0)
    expect(popconBarWidth(0)).toBe(0)
    expect(popconBarWidth(-1)).toBe(0)
  })

  it('saturates at 100 for the anchor and above', () => {
    // anchor = 100_000 installs.
    expect(popconBarWidth(100_000)).toBe(100)
    expect(popconBarWidth(5_000_000)).toBe(100)
  })

  it('is LOG-scaled, not linear', () => {
    // Linear would put 1000/100000 at 1%. Log puts it near 60% — that is the
    // point: install counts span five orders of magnitude and linear renders
    // everything but the top few as an identical sliver.
    const w = popconBarWidth(1_000)
    expect(w).toBeGreaterThan(50)
    expect(w).toBeLessThan(65)
    expect(w).not.toBeCloseTo(1, 0)
  })

  it('increases monotonically', () => {
    let prev = -1
    for (const n of [1, 10, 100, 1_000, 10_000, 50_000, 100_000]) {
      const w = popconBarWidth(n)
      expect(w, String(n)).toBeGreaterThan(prev)
      prev = w
    }
  })

  it('never exceeds 100', () => {
    for (const n of [1, 100_000, 1e9, Number.MAX_SAFE_INTEGER]) {
      expect(popconBarWidth(n)).toBeLessThanOrEqual(100)
    }
  })
})

describe('highlightSegments', () => {
  it('returns null when there is nothing to highlight', () => {
    // The caller renders the original string rather than wrapping every
    // character in a span.
    expect(highlightSegments('anything', '')).toBeNull()
    expect(highlightSegments('anything', '   ')).toBeNull()
  })

  it('splits into plain/match alternation with matches at ODD indices', () => {
    // The parity contract the renderer keys on. Holds because the regex has
    // exactly one capture group.
    expect(highlightSegments('the apt package', 'apt')).toEqual([
      'the ',
      'apt',
      ' package',
    ])
  })

  it('is case-insensitive but preserves the ORIGINAL casing in the match', () => {
    expect(highlightSegments('The APT package', 'apt')).toEqual([
      'The ',
      'APT',
      ' package',
    ])
  })

  it('highlights every occurrence, not just the first', () => {
    const out = highlightSegments('apt and apt again', 'apt')
    expect(out).toEqual(['', 'apt', ' and ', 'apt', ' again'])
    // Even indices plain, odd indices matched — verified positionally.
    expect(out?.filter((_, i) => i % 2 === 1)).toEqual(['apt', 'apt'])
  })

  it('splits multi-word queries into independent tokens', () => {
    // "machine learning" highlights both words separately.
    const out = highlightSegments('machine and learning', 'machine learning')
    expect(out?.filter((_, i) => i % 2 === 1)).toEqual(['machine', 'learning'])
  })

  it('ESCAPES regex metacharacters — the query is matched literally', () => {
    // Without escaping, each of these would throw or match wrongly. Verified
    // for the cases that actually occur in Debian package names.
    expect(highlightSegments('the g++ compiler', 'g++')).toEqual([
      'the ',
      'g++',
      ' compiler',
    ])
    expect(highlightSegments('lib.so here', 'lib.so')).toEqual([
      '',
      'lib.so',
      ' here',
    ])
    // A literal dot must NOT match an arbitrary character.
    expect(highlightSegments('libXso here', 'lib.so')).toEqual(['libXso here'])
  })

  it('does not throw on any metacharacter-heavy query', () => {
    for (const q of ['a|b', '(paren)', 'a*', '[abc]', '^caret', '$var', 'back\\slash', 'a+b?']) {
      expect(() => highlightSegments('sample ' + q + ' text', q), q).not.toThrow()
    }
  })

  it('returns a single-element array when the query does not match', () => {
    expect(highlightSegments('nothing here', 'zzz')).toEqual(['nothing here'])
  })

  it('handles a query that is the whole string', () => {
    expect(highlightSegments('apt', 'apt')).toEqual(['', 'apt', ''])
  })
})
