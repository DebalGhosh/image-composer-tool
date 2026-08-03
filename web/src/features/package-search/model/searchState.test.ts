import { describe, it, expect } from 'vitest'
import {
  searchReducer,
  initialSearchState,
  PAGE_JUMP,
  type SearchState,
  type SearchAction,
} from './searchState'
import type { PackageDetails } from '@/api/types'

function pkg(name: string): PackageDetails {
  return {
    name,
    version: '1.0',
    description: '',
    arch: 'amd64',
    section: 'admin',
    repository: 'noble/main',
    os: 'ubuntu24',
    type: 'deb',
  }
}

/** Fold a sequence of actions, as the component would. */
function run(actions: SearchAction[], from: SearchState = initialSearchState) {
  return actions.reduce(searchReducer, from)
}

describe('initial state', () => {
  it('starts empty, not loading, focused on the first row', () => {
    expect(initialSearchState).toEqual({
      query: '',
      entries: [],
      loading: false,
      indexMissing: false,
      selectedSections: [],
      focusIdx: 0,
      detailFocused: false,
    })
  })
})

describe('query', () => {
  it('records the query', () => {
    expect(run([{ type: 'queryChanged', query: 'openvino' }]).query).toBe('openvino')
  })

  it('does NOT reset focus while typing', () => {
    // Focus resets when the fetch RESOLVES, not on keystroke — otherwise the
    // highlighted row jumps under the user's fingers while the old results are
    // still on screen.
    const s = run([
      { type: 'focusSet', index: 5 },
      { type: 'queryChanged', query: 'op' },
    ])
    expect(s.focusIdx).toBe(5)
  })

  it('does not clear entries while typing', () => {
    const s = run([
      { type: 'fetchSucceeded', entries: [pkg('a')], indexMissing: false },
      { type: 'queryChanged', query: 'zzz' },
    ])
    expect(s.entries).toHaveLength(1)
  })
})

describe('fetch lifecycle', () => {
  it('fetchStarted only sets loading', () => {
    const s = run([
      { type: 'fetchSucceeded', entries: [pkg('a')], indexMissing: false },
      { type: 'fetchStarted' },
    ])
    expect(s.loading).toBe(true)
    expect(s.entries).toHaveLength(1) // old results stay visible
  })

  it('fetchSucceeded sets entries, clears loading and resets focus ATOMICALLY', () => {
    // The whole reason for the reducer: as four separate setters, focusIdx could
    // briefly point past the end of a shorter new result set.
    const s = run([
      { type: 'fetchStarted' },
      { type: 'focusSet', index: 40 },
      { type: 'fetchSucceeded', entries: [pkg('a'), pkg('b')], indexMissing: false },
    ])
    expect(s.entries.map((e) => e.name)).toEqual(['a', 'b'])
    expect(s.loading).toBe(false)
    expect(s.focusIdx).toBe(0)
  })

  it('carries indexMissing through from the caller', () => {
    expect(
      run([{ type: 'fetchSucceeded', entries: [], indexMissing: true }]).indexMissing,
    ).toBe(true)
  })

  it('fetchFailed clears loading but KEEPS the previous entries', () => {
    // A transient blip must not blank-slate the user.
    const s = run([
      { type: 'fetchSucceeded', entries: [pkg('a')], indexMissing: false },
      { type: 'fetchStarted' },
      { type: 'fetchFailed' },
    ])
    expect(s.loading).toBe(false)
    expect(s.entries.map((e) => e.name)).toEqual(['a'])
  })

  it('fetchSkipped clears entries WITHOUT entering the loading state', () => {
    // No OS selected: there is nothing to wait for, so a spinner would lie.
    const s = run([
      { type: 'fetchSucceeded', entries: [pkg('a')], indexMissing: false },
      { type: 'fetchSkipped' },
    ])
    expect(s.entries).toEqual([])
    expect(s.loading).toBe(false)
  })
})

describe('section facets', () => {
  it('toggles on, appending', () => {
    const s = run([
      { type: 'sectionToggled', section: 'admin' },
      { type: 'sectionToggled', section: 'net' },
    ])
    expect(s.selectedSections).toEqual(['admin', 'net'])
  })

  it('toggles off, preserving the order of the rest', () => {
    const s = run([
      { type: 'sectionToggled', section: 'admin' },
      { type: 'sectionToggled', section: 'net' },
      { type: 'sectionToggled', section: 'devel' },
      { type: 'sectionToggled', section: 'net' },
    ])
    expect(s.selectedSections).toEqual(['admin', 'devel'])
  })

  it('clears all', () => {
    const s = run([
      { type: 'sectionToggled', section: 'admin' },
      { type: 'sectionsCleared' },
    ])
    expect(s.selectedSections).toEqual([])
  })

  it('does NOT reset focus when a facet changes', () => {
    // Pinned as current behaviour: the original's setSelectedSections did not
    // touch focusIdx. The visible list can shrink, so focus may end up past the
    // end until the next keypress clamps it — that is pre-existing.
    const s = run([
      { type: 'focusSet', index: 7 },
      { type: 'sectionToggled', section: 'admin' },
    ])
    expect(s.focusIdx).toBe(7)
  })
})

describe('focus movement', () => {
  it('arrow keys WRAP at both ends', () => {
    const at = (i: number, delta: number, n: number) =>
      searchReducer({ ...initialSearchState, focusIdx: i }, {
        type: 'focusMoved',
        delta,
        wrap: true,
        visibleCount: n,
      }).focusIdx

    expect(at(0, 1, 5)).toBe(1)
    expect(at(4, 1, 5)).toBe(0) // wraps forward
    expect(at(0, -1, 5)).toBe(4) // wraps backward — never negative
    expect(at(2, -1, 5)).toBe(1)
  })

  it('page keys CLAMP rather than wrap', () => {
    // A 10-row jump that wrapped to the top would be disorienting.
    const at = (i: number, delta: number, n: number) =>
      searchReducer({ ...initialSearchState, focusIdx: i }, {
        type: 'focusMoved',
        delta,
        wrap: false,
        visibleCount: n,
      }).focusIdx

    expect(at(0, PAGE_JUMP, 100)).toBe(10)
    expect(at(95, PAGE_JUMP, 100)).toBe(99) // clamps at the end
    expect(at(3, -PAGE_JUMP, 100)).toBe(0) // clamps at the start
  })

  it('collapses to 0 when there are no visible rows', () => {
    for (const wrap of [true, false]) {
      const s = searchReducer({ ...initialSearchState, focusIdx: 7 }, {
        type: 'focusMoved',
        delta: 1,
        wrap,
        visibleCount: 0,
      })
      expect(s.focusIdx, String(wrap)).toBe(0)
    }
  })

  it('Home and End jump to the ends', () => {
    expect(run([{ type: 'focusSet', index: 9 }, { type: 'focusFirst' }]).focusIdx).toBe(0)
    expect(run([{ type: 'focusLast', visibleCount: 42 }]).focusIdx).toBe(41)
  })

  it('End on an empty list stays at 0 rather than going to -1', () => {
    expect(run([{ type: 'focusLast', visibleCount: 0 }]).focusIdx).toBe(0)
  })

  it('focusSet is used verbatim — hover/click sets an exact index', () => {
    expect(run([{ type: 'focusSet', index: 12 }]).focusIdx).toBe(12)
  })
})

describe('detail pane focus', () => {
  it('toggles', () => {
    expect(run([{ type: 'detailFocused', focused: true }]).detailFocused).toBe(true)
    expect(
      run([
        { type: 'detailFocused', focused: true },
        { type: 'detailFocused', focused: false },
      ]).detailFocused,
    ).toBe(false)
  })
})

describe('dialogClosed', () => {
  it('resets query, facets, focus and detail focus', () => {
    const s = run([
      { type: 'queryChanged', query: 'openvino' },
      { type: 'sectionToggled', section: 'admin' },
      { type: 'focusSet', index: 5 },
      { type: 'detailFocused', focused: true },
      { type: 'dialogClosed' },
    ])
    expect(s.query).toBe('')
    expect(s.selectedSections).toEqual([])
    expect(s.focusIdx).toBe(0)
    expect(s.detailFocused).toBe(false)
  })

  it('KEEPS entries and indexMissing', () => {
    // The next open re-fetches anyway; holding the previous page means the list
    // is not empty for the first 200ms of debounce.
    const s = run([
      { type: 'fetchSucceeded', entries: [pkg('a')], indexMissing: true },
      { type: 'dialogClosed' },
    ])
    expect(s.entries).toHaveLength(1)
    expect(s.indexMissing).toBe(true)
  })
})

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before: SearchState = {
      ...initialSearchState,
      entries: [pkg('a')],
      selectedSections: ['admin'],
    }
    const snapshot = JSON.parse(JSON.stringify(before))
    const actions: SearchAction[] = [
      { type: 'queryChanged', query: 'x' },
      { type: 'fetchStarted' },
      { type: 'fetchSucceeded', entries: [pkg('b')], indexMissing: false },
      { type: 'sectionToggled', section: 'net' },
      { type: 'sectionsCleared' },
      { type: 'focusMoved', delta: 1, wrap: true, visibleCount: 3 },
      { type: 'dialogClosed' },
    ]
    for (const a of actions) searchReducer(before, a)
    expect(before).toEqual(snapshot)
  })

  it('returns the same object for an unknown action', () => {
    // Exhaustive switch + default passthrough, so a stray dispatch cannot
    // silently blank the state.
    const s = { ...initialSearchState, query: 'keep' }
    expect(searchReducer(s, { type: 'nope' } as unknown as SearchAction)).toBe(s)
  })
})
