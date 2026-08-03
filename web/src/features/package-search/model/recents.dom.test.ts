import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { loadRecents, pushRecent, RECENTS_KEY, RECENTS_CAP } from './recents'

/**
 * The recents list is one of four localStorage schemas this app owns. Renaming
 * the key silently discards every user's history, so the key and cap are pinned
 * literally.
 */

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('storage contract', () => {
  it('pins the key and the cap', () => {
    expect(RECENTS_KEY).toBe('ict.packagesearch.recents')
    expect(RECENTS_CAP).toBe(10)
  })

  it('writes under that exact key', () => {
    pushRecent('openvino')
    expect(JSON.parse(window.localStorage.getItem(RECENTS_KEY) as string)).toEqual([
      'openvino',
    ])
  })
})

describe('loadRecents', () => {
  it('returns [] when nothing is stored', () => {
    expect(loadRecents()).toEqual([])
  })

  it('reads a stored list', () => {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(['a', 'b']))
    expect(loadRecents()).toEqual(['a', 'b'])
  })

  it('returns [] for corrupt JSON rather than throwing', () => {
    window.localStorage.setItem(RECENTS_KEY, '{not json')
    expect(loadRecents()).toEqual([])
  })

  it('returns [] for a non-array payload', () => {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify({ nope: 1 }))
    expect(loadRecents()).toEqual([])
  })

  it('filters non-strings out of a partially-corrupt array', () => {
    // A per-element filter, not an all-or-nothing reject — usable entries survive.
    window.localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(['good', 42, null, { x: 1 }, 'also-good']),
    )
    expect(loadRecents()).toEqual(['good', 'also-good'])
  })

  it('truncates an over-long stored list to the cap on READ', () => {
    const many = Array.from({ length: 25 }, (_, i) => 'q' + i)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(many))
    expect(loadRecents()).toHaveLength(RECENTS_CAP)
    expect(loadRecents()[0]).toBe('q0')
  })

  it('returns [] when reads throw (storage disabled)', () => {
    const proto = Object.getPrototypeOf(window.localStorage) as Storage
    const spy = vi.spyOn(proto, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })
    expect(loadRecents()).toEqual([])
    spy.mockRestore()
  })
})

describe('pushRecent', () => {
  it('prepends, most-recent-first', () => {
    pushRecent('first')
    expect(pushRecent('second')).toEqual(['second', 'first'])
  })

  it('IGNORES queries shorter than 2 characters', () => {
    // One-char noise is not worth caching. Note it returns the UNCHANGED list,
    // not an empty one.
    pushRecent('openvino')
    expect(pushRecent('a')).toEqual(['openvino'])
    expect(pushRecent('')).toEqual(['openvino'])
    expect(pushRecent(' ')).toEqual(['openvino'])
    expect(loadRecents()).toEqual(['openvino'])
  })

  it('accepts exactly 2 characters', () => {
    expect(pushRecent('ab')).toEqual(['ab'])
  })

  it('trims before storing', () => {
    expect(pushRecent('  openvino  ')).toEqual(['openvino'])
  })

  it('PROMOTES an existing entry rather than duplicating it', () => {
    pushRecent('a1')
    pushRecent('b2')
    pushRecent('c3')
    expect(pushRecent('a1')).toEqual(['a1', 'c3', 'b2'])
    expect(loadRecents().filter((x) => x === 'a1')).toHaveLength(1)
  })

  it('caps the list at 10, evicting the OLDEST', () => {
    for (let i = 0; i < 12; i++) pushRecent('q' + i)
    const out = loadRecents()
    expect(out).toHaveLength(RECENTS_CAP)
    expect(out[0]).toBe('q11') // newest first
    expect(out).not.toContain('q0')
    expect(out).not.toContain('q1')
  })

  it('returns the intended next list even when the WRITE fails', () => {
    // Quota / private mode: persistence is impossible but the UI must stay
    // consistent for the session.
    const proto = Object.getPrototypeOf(window.localStorage) as Storage
    const spy = vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(() => pushRecent('openvino')).not.toThrow()
    expect(pushRecent('openvino')).toEqual(['openvino'])
    spy.mockRestore()
  })
})
