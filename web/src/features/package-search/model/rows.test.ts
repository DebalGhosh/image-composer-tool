import { describe, it, expect } from 'vitest'
import {
  filterBySections,
  shouldOfferSynthetic,
  syntheticEntry,
  visibleRows,
  groupRows,
  sectionFacets,
  type VisibleRow,
} from './rows'
import type { PackageDetails } from '@/api/types'

function pkg(name: string, section = 'admin'): PackageDetails {
  return {
    name,
    version: '1.0',
    description: name + ' description',
    arch: 'amd64',
    section,
    repository: 'noble/main',
    os: 'ubuntu24',
    type: 'deb',
  }
}

const BASE = {
  rerankedNames: null,
  query: '',
  selectedSections: [],
  values: [],
  os: 'ubuntu24',
  arch: 'x86_64',
}

describe('filterBySections', () => {
  it('passes everything through when nothing is selected', () => {
    const e = [pkg('a'), pkg('b')]
    expect(filterBySections(e, [])).toBe(e) // same reference — no copy
  })

  it('keeps only the selected sections', () => {
    const e = [pkg('a', 'admin'), pkg('b', 'net'), pkg('c', 'admin')]
    expect(filterBySections(e, ['admin']).map((x) => x.name)).toEqual(['a', 'c'])
  })

  it('is a UNION for multi-select, not an intersection', () => {
    // A package has exactly one section, so an intersection would always be
    // empty. Selecting two sections must WIDEN the list.
    const e = [pkg('a', 'admin'), pkg('b', 'net'), pkg('c', 'devel')]
    expect(filterBySections(e, ['admin', 'net']).map((x) => x.name)).toEqual(['a', 'b'])
  })

  it('buckets a missing section under (none) so it stays filterable', () => {
    const e = [pkg('a', ''), pkg('b', 'net')]
    expect(filterBySections(e, ['(none)']).map((x) => x.name)).toEqual(['a'])
  })
})

describe('shouldOfferSynthetic', () => {
  const rows = (names: string[]): VisibleRow[] => names.map((n) => ({ entry: pkg(n) }))

  it('offers for a legal name not already present or selected', () => {
    expect(shouldOfferSynthetic('my-pkg', [], rows(['other']))).toBe(true)
  })

  it('does not offer for an empty query', () => {
    expect(shouldOfferSynthetic('', [], [])).toBe(false)
  })

  it('does not offer for an illegal package name', () => {
    // PKG_NAME_RE requires an alphanumeric first char and no spaces.
    for (const q of ['-leading', 'has space', 'sla/sh', '(paren)']) {
      expect(shouldOfferSynthetic(q, [], []), q).toBe(false)
    }
  })

  it('does not offer when the name is ALREADY SELECTED', () => {
    expect(shouldOfferSynthetic('apt', ['apt'], [])).toBe(false)
  })

  it('does not offer when the name is already in the results', () => {
    expect(shouldOfferSynthetic('apt', [], rows(['apt']))).toBe(false)
  })

  it('accepts the glob forms the escape hatch exists for', () => {
    expect(shouldOfferSynthetic('ros-jazzy-*', [], [])).toBe(true)
  })
})

describe('syntheticEntry', () => {
  it('normalises the arch and marks the section', () => {
    const e = syntheticEntry('my-pkg', 'ubuntu24', 'x86_64')
    expect(e.name).toBe('my-pkg')
    expect(e.arch).toBe('amd64') // ICT label -> Debian name
    expect(e.section).toBe('(user-added)')
    expect(e.description).toBe('User-added — will be included verbatim')
    expect(e.version).toBe('')
  })
})

describe('visibleRows', () => {
  it('returns entries in SERVER order when reranking did not run', () => {
    const entries = [pkg('zzz'), pkg('aaa'), pkg('mmm')]
    expect(visibleRows({ ...BASE, entries }).map((r) => r.entry.name)).toEqual([
      'zzz',
      'aaa',
      'mmm',
    ])
  })

  it('reorders to the reranked sequence when one is supplied', () => {
    const entries = [pkg('zzz'), pkg('aaa'), pkg('mmm')]
    expect(
      visibleRows({ ...BASE, entries, rerankedNames: ['mmm', 'zzz', 'aaa'] }).map(
        (r) => r.entry.name,
      ),
    ).toEqual(['mmm', 'zzz', 'aaa'])
  })

  it('DROPS a reranked name with no matching entry', () => {
    // The MiniSearch index can outlive the entry list by one render during a
    // fetch; a dangling name must not produce an undefined row that the
    // keyboard nav would land on.
    const entries = [pkg('aaa')]
    expect(
      visibleRows({ ...BASE, entries, rerankedNames: ['ghost', 'aaa'] }).map(
        (r) => r.entry.name,
      ),
    ).toEqual(['aaa'])
  })

  it('applies the facet filter after reranking', () => {
    const entries = [pkg('a', 'admin'), pkg('b', 'net')]
    const out = visibleRows({
      ...BASE,
      entries,
      rerankedNames: ['b', 'a'],
      selectedSections: ['net'],
    })
    expect(out.map((r) => r.entry.name)).toEqual(['b'])
  })

  it('PREPENDS the synthetic row so it is reachable without scrolling', () => {
    const entries = Array.from({ length: 5 }, (_, i) => pkg('p' + i))
    const out = visibleRows({ ...BASE, entries, query: 'my-pkg' })
    expect(out[0].isSynthetic).toBe(true)
    expect(out[0].entry.name).toBe('my-pkg')
    expect(out).toHaveLength(6)
  })

  it('omits the synthetic row when the query matches an existing result', () => {
    const entries = [pkg('apt')]
    const out = visibleRows({ ...BASE, entries, query: 'apt' })
    expect(out.some((r) => r.isSynthetic)).toBe(false)
    expect(out).toHaveLength(1)
  })

  it('checks the synthetic condition AFTER filtering', () => {
    // 'apt' exists but is filtered out by the facet, so the +Add row IS offered
    // — the check runs against the visible rows, not the raw entries.
    const entries = [pkg('apt', 'admin')]
    const out = visibleRows({
      ...BASE,
      entries,
      query: 'apt',
      selectedSections: ['net'],
    })
    expect(out).toHaveLength(1)
    expect(out[0].isSynthetic).toBe(true)
  })

  it('trims the query before using it', () => {
    const out = visibleRows({ ...BASE, entries: [], query: '  my-pkg  ' })
    expect(out[0].entry.name).toBe('my-pkg')
  })

  it('returns an empty list for no entries and no query', () => {
    expect(visibleRows({ ...BASE, entries: [] })).toEqual([])
  })
})

describe('groupRows', () => {
  it('buckets by the shared groupFor rules', () => {
    const rows: VisibleRow[] = [
      { entry: pkg('apt') },
      { entry: pkg('linux-image-generic') },
      { entry: pkg('ros-jazzy-desktop') },
      { entry: pkg('vim') },
    ]
    expect(groupRows(rows).map(([g]) => g)).toEqual([
      'Base',
      'Boot & kernel',
      'ROS 2',
      'Other',
    ])
  })

  it('is INSERTION-ordered, not sorted by the GroupKey enum', () => {
    // Header order must match the flat list the keyboard walks.
    const rows: VisibleRow[] = [{ entry: pkg('vim') }, { entry: pkg('apt') }]
    expect(groupRows(rows).map(([g]) => g)).toEqual(['Other', 'Base'])
  })

  it('gives the synthetic row its own User-added bucket', () => {
    // Not grouped by name — it must not look like a real indexed package.
    const rows: VisibleRow[] = [
      { entry: pkg('apt'), isSynthetic: true },
      { entry: pkg('apt') },
    ]
    const out = groupRows(rows)
    expect(out.map(([g]) => g)).toEqual(['User-added', 'Base'])
  })

  it('preserves within-bucket order', () => {
    const rows: VisibleRow[] = [
      { entry: pkg('sudo') },
      { entry: pkg('vim') },
      { entry: pkg('apt') },
    ]
    const base = groupRows(rows).find(([g]) => g === 'Base')?.[1]
    expect(base?.map((r) => r.entry.name)).toEqual(['sudo', 'apt'])
  })

  it('flattens back to the original list', () => {
    const rows: VisibleRow[] = ['apt', 'vim', 'linux-image-x', 'curl'].map((n) => ({
      entry: pkg(n),
    }))
    const flat = groupRows(rows).flatMap(([, rs]) => rs)
    expect(flat).toHaveLength(rows.length)
    expect(new Set(flat.map((r) => r.entry.name))).toEqual(
      new Set(rows.map((r) => r.entry.name)),
    )
  })

  it('handles an empty list', () => {
    expect(groupRows([])).toEqual([])
  })
})

describe('sectionFacets', () => {
  it('counts per section, descending', () => {
    const e = [pkg('a', 'net'), pkg('b', 'admin'), pkg('c', 'admin'), pkg('d', 'admin')]
    expect(sectionFacets(e)).toEqual([
      { section: 'admin', count: 3 },
      { section: 'net', count: 1 },
    ])
  })

  it('buckets a missing section as (none)', () => {
    expect(sectionFacets([pkg('a', '')])).toEqual([{ section: '(none)', count: 1 }])
  })

  it('is computed from the UNFILTERED entries', () => {
    // If counts came from the filtered list, selecting one facet would zero
    // every other one and the user could not widen the selection. This function
    // takes `entries`, never the filtered rows — asserted by construction: the
    // signature has no `selectedSections` parameter.
    expect(sectionFacets.length).toBe(1)
  })

  it('handles an empty entry list', () => {
    expect(sectionFacets([])).toEqual([])
  })
})
