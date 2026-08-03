import { describe, it, expect, beforeEach } from 'vitest'
import {
  readUrlState,
  serializeUrlState,
  replaceUrlState,
  type View,
} from '@/lib/urlState'

/**
 * urlState is the whole of this app's "routing": a ?view= query param read by
 * App.tsx, deliberately in place of react-router because all four pages must
 * stay mounted at once (hidden tabs preserve draft state, and InteractivePage's
 * Cmd+K guard detects hiddenness via offsetParent === null).
 *
 * Pins the parse/serialise contract before that logic is relocated into app/.
 * Needs a DOM because every function reads window.location / window.history.
 */

const ALL_VIEWS: readonly View[] = ['basic', 'advanced', 'interactive', 'builds']

function setSearch(search: string) {
  window.history.replaceState(null, '', search === '' ? '/' : search)
}

beforeEach(() => setSearch('/'))

describe('readUrlState', () => {
  it('reads each known view verbatim', () => {
    for (const v of ALL_VIEWS) {
      setSearch(`?view=${v}`)
      expect(readUrlState()).toEqual({ view: v })
    }
  })

  it('falls back to basic for absent, empty or unknown values', () => {
    for (const search of ['/', '?', '?view=', '?view=nope', '?other=advanced']) {
      setSearch(search)
      expect(readUrlState().view).toBe('basic')
    }
  })

  it('is case-sensitive, so a mis-cased view falls back rather than half-matching', () => {
    setSearch('?view=ADVANCED')
    expect(readUrlState().view).toBe('basic')
  })
})

describe('serializeUrlState', () => {
  it('omits the default view so the Basic tab reads as a clean path', () => {
    expect(serializeUrlState({ view: 'basic' })).toBe(window.location.pathname)
  })

  it('emits ?view= for every non-default view', () => {
    for (const v of ALL_VIEWS.filter((x) => x !== 'basic')) {
      expect(serializeUrlState({ view: v })).toBe(`?view=${v}`)
    }
  })
})

describe('round trip', () => {
  it('survives serialise -> read for every view', () => {
    for (const v of ALL_VIEWS) {
      setSearch(serializeUrlState({ view: v }))
      expect(readUrlState().view).toBe(v)
    }
  })
})

describe('replaceUrlState', () => {
  it('does not grow the history stack', () => {
    const before = window.history.length
    replaceUrlState({ view: 'builds' })
    replaceUrlState({ view: 'interactive' })
    expect(window.history.length).toBe(before)
    expect(readUrlState().view).toBe('interactive')
  })

  it('no-ops when the URL already matches, so popstate is not polluted', () => {
    setSearch('?view=builds')
    const before = window.location.search
    replaceUrlState({ view: 'builds' })
    expect(window.location.search).toBe(before)
  })
})
