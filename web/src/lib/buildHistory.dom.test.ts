import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { useBuildHistory, type BuildHistoryEntry } from '@/lib/buildHistory'

/**
 * Characterisation tests for useBuildHistory.
 *
 * This hook is the model the refactor points at for "Custom Hook as Facade", and
 * FE-7 splits store.ts alongside it. Its localStorage contract is the risk: the
 * KEY NAMES and the 50-entry FIFO cap are load-bearing, and a renamed key
 * silently discards every user's build history with no error anywhere.
 *
 * Pins current behaviour, quirks included.
 */

const KEY_ENTRIES = 'ict.buildHistory.v1'
const KEY_SELECTED = 'ict.buildHistory.selected.v1'

function entry(id: string, over: Partial<BuildHistoryEntry> = {}): BuildHistoryEntry {
  return {
    buildId: id,
    worker: null,
    buildNo: null,
    startedAt: 1_700_000_000_000,
    status: 'running',
    jenkinsBuildUrl: null,
    jenkinsJobUrl: 'https://jenkins.invalid/job/ict-farm/',
    ...over,
  }
}

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('storage keys', () => {
  it('writes entries under the exact documented key', () => {
    // ⚠️ Renaming this key discards every existing user's history silently.
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('b1')))
    const raw = window.localStorage.getItem(KEY_ENTRIES)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toHaveLength(1)
  })

  it('writes the selection under its own separate key', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.setSelectedBuildId('b1'))
    expect(window.localStorage.getItem(KEY_SELECTED)).toBe('b1')
  })

  it('removes rather than nulls the selection key when cleared', () => {
    window.localStorage.setItem(KEY_SELECTED, 'b1')
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.setSelectedBuildId(null))
    // removeItem, not setItem('null') — so a later read gets null, not "null".
    expect(window.localStorage.getItem(KEY_SELECTED)).toBeNull()
  })
})

describe('seeding from storage', () => {
  it('reads existing entries synchronously on first render, with no empty flash', () => {
    window.localStorage.setItem(KEY_ENTRIES, JSON.stringify([entry('seeded')]))
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].buildId).toBe('seeded')
  })

  it('seeds the selection too', () => {
    window.localStorage.setItem(KEY_SELECTED, 'chosen')
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.selectedBuildId).toBe('chosen')
  })

  it('tolerates corrupt JSON by starting empty instead of throwing', () => {
    window.localStorage.setItem(KEY_ENTRIES, '{not json')
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.entries).toEqual([])
  })

  it('tolerates a non-array payload', () => {
    window.localStorage.setItem(KEY_ENTRIES, JSON.stringify({ nope: true }))
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.entries).toEqual([])
  })

  it('drops only the rows missing the primary key, keeping the rest', () => {
    // The defensive filter exists so a partially-corrupted payload cannot crash
    // render. It is a FILTER, not an all-or-nothing reject.
    window.localStorage.setItem(
      KEY_ENTRIES,
      JSON.stringify([entry('good'), { worker: 'w' }, null, 'string', entry('good2')]),
    )
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.entries.map((e) => e.buildId)).toEqual(['good', 'good2'])
  })
})

describe('addEntry', () => {
  it('prepends, so the list is newest-first', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('first')))
    act(() => result.current.addEntry(entry('second')))
    expect(result.current.entries.map((e) => e.buildId)).toEqual(['second', 'first'])
  })

  it('de-dupes by buildId, moving the re-added row to the top', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.addEntry(entry('b')))
    act(() => result.current.addEntry(entry('a', { status: 'success' })))
    expect(result.current.entries.map((e) => e.buildId)).toEqual(['a', 'b'])
    expect(result.current.entries[0].status).toBe('success')
  })

  it('caps at 50 entries, evicting the OLDEST', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => {
      for (let i = 0; i < 51; i++) result.current.addEntry(entry(`b${i}`))
    })
    expect(result.current.entries).toHaveLength(50)
    // Newest-first + slice(0, 50) means b0 (the first added) is gone.
    expect(result.current.entries[0].buildId).toBe('b50')
    expect(result.current.entries.map((e) => e.buildId)).not.toContain('b0')
  })
})

describe('updateEntry', () => {
  it('merges a patch into the matching row', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.updateEntry('a', { worker: 'worker-07', buildNo: 18 }))
    expect(result.current.entries[0].worker).toBe('worker-07')
    expect(result.current.entries[0].buildNo).toBe(18)
    // untouched fields survive the merge
    expect(result.current.entries[0].status).toBe('running')
  })

  it('silently no-ops for an unknown buildId', () => {
    // BuildView polls every 5s and may reference a build the user just deleted.
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.updateEntry('ghost', { status: 'failed' }))
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].status).toBe('running')
  })

  it('never lets a patch overwrite the primary key', () => {
    // merged = { ...prev[idx], ...patch, buildId } — buildId is re-applied LAST.
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() =>
      result.current.updateEntry('a', {
        buildId: 'hijacked',
        status: 'success',
      } as Partial<BuildHistoryEntry>),
    )
    expect(result.current.entries[0].buildId).toBe('a')
    expect(result.current.entries[0].status).toBe('success')
  })

  it('preserves list position rather than promoting the updated row', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.addEntry(entry('b')))
    act(() => result.current.updateEntry('a', { status: 'success' }))
    expect(result.current.entries.map((e) => e.buildId)).toEqual(['b', 'a'])
  })
})

describe('deleteEntry', () => {
  it('removes the row', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.addEntry(entry('b')))
    act(() => result.current.deleteEntry('a'))
    expect(result.current.entries.map((e) => e.buildId)).toEqual(['b'])
  })

  it('clears the selection only when the DELETED row was selected', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.addEntry(entry('b')))
    act(() => result.current.setSelectedBuildId('b'))
    act(() => result.current.deleteEntry('a'))
    expect(result.current.selectedBuildId).toBe('b')
    act(() => result.current.deleteEntry('b'))
    expect(result.current.selectedBuildId).toBeNull()
  })
})

describe('clearAll', () => {
  it('empties the list and the selection', () => {
    const { result } = renderHook(() => useBuildHistory())
    act(() => result.current.addEntry(entry('a')))
    act(() => result.current.setSelectedBuildId('a'))
    act(() => result.current.clearAll())
    expect(result.current.entries).toEqual([])
    expect(result.current.selectedBuildId).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(KEY_ENTRIES) as string)).toEqual([])
  })
})

describe('write failures degrade silently', () => {
  it('does not throw when localStorage.setItem rejects (quota / disabled)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Spy on Storage.prototype, NOT on window.localStorage. In jsdom, setItem is
    // an own property of Storage.prototype and the instance merely inherits it,
    // so vi.spyOn(window.localStorage, 'setItem') installs a spy that is never
    // reached — it silently observes nothing and the test would pass vacuously.
    const proto = Object.getPrototypeOf(window.localStorage) as Storage
    const setItem = vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => useBuildHistory())
    expect(() => act(() => result.current.addEntry(entry('a')))).not.toThrow()
    // In-memory state still updates — losing the append is better than a crash.
    expect(result.current.entries).toHaveLength(1)
    expect(setItem).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('starts empty when reads throw (storage disabled entirely)', () => {
    const proto = Object.getPrototypeOf(window.localStorage) as Storage
    const getItem = vi.spyOn(proto, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })
    const { result } = renderHook(() => useBuildHistory())
    expect(result.current.entries).toEqual([])
    expect(result.current.selectedBuildId).toBeNull()
    getItem.mockRestore()
  })
})
