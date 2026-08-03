/**
 * The derived-state pipeline: server entries -> reranked -> facet-filtered ->
 * grouped, plus the synthetic "+ Add" row. Pure — no React, no DOM, no fetch.
 *
 * This is the logic the keyboard navigation indexes into, so its ORDER is a
 * contract: `visibleRows` returns the flat list in exactly the sequence the user
 * arrows through, and `groupRows` re-buckets that same list for the sticky
 * headers without reordering it.
 *
 * Extracted from PackageSearchDialog.tsx.
 */
import type { PackageDetails } from '@/api/types'
import { PKG_NAME_RE, groupFor, normalizeArch, type GroupKey } from '../packageSearchShared'

export interface VisibleRow {
  entry: PackageDetails
  /** True for the '+ Add "…"' escape-hatch row. */
  isSynthetic?: boolean
}

/** Minimum query length before client-side reranking engages. */
export const RERANK_MIN_QUERY = 2

/**
 * Apply the section facet filter.
 *
 * ⚠️ MULTI-SELECT IS A UNION, NOT AN INTERSECTION: selecting two sections WIDENS
 * the list to everything in either. A package has exactly one section, so an
 * intersection would always be empty — the union is the only useful reading.
 *
 * Entries with no section are bucketed under '(none)' so they remain
 * filterable rather than vanishing.
 */
export function filterBySections(
  entries: PackageDetails[],
  selectedSections: string[],
): PackageDetails[] {
  if (selectedSections.length === 0) return entries
  const wanted = new Set(selectedSections)
  return entries.filter((e) => wanted.has(e.section || '(none)'))
}

/**
 * Should the synthetic '+ Add "q"' row be offered?
 *
 * Four conditions, all required: a non-empty query, a query that is a legal
 * package name, not already selected, and not already present in the results.
 * The last two are what stop the row appearing as a duplicate of something the
 * user can already see or has already picked.
 */
export function shouldOfferSynthetic(
  q: string,
  values: string[],
  rows: VisibleRow[],
): boolean {
  return (
    q.length > 0 &&
    PKG_NAME_RE.test(q) &&
    !values.includes(q) &&
    !rows.some((r) => r.entry.name === q)
  )
}

/** The placeholder record backing the '+ Add' row. */
export function syntheticEntry(
  q: string,
  os: string,
  arch: string,
): PackageDetails {
  return {
    name: q,
    version: '',
    description: 'User-added — will be included verbatim',
    arch: normalizeArch(arch),
    section: '(user-added)',
    repository: '',
    os,
    type: 'deb',
  }
}

export interface VisibleRowsRequest {
  /** Server entries, in server order. */
  entries: PackageDetails[]
  /** Names in reranked order, or null when reranking did not run. */
  rerankedNames: string[] | null
  query: string
  selectedSections: string[]
  /** Already-selected package names — used to suppress a duplicate +Add row. */
  values: string[]
  os: string
  arch: string
}

/**
 * Build the flat visible list.
 *
 * Reranking is passed in as an ordered name list rather than done here, because
 * MiniSearch is stateful and belongs to the component; this keeps the ordering
 * decision testable while leaving the index where it has to live.
 *
 * A reranked name with no matching entry is DROPPED rather than skipped over —
 * the index can outlive the entry list by one render during a fetch.
 */
export function visibleRows(req: VisibleRowsRequest): VisibleRow[] {
  const q = req.query.trim()

  let base: PackageDetails[]
  if (req.rerankedNames) {
    const byName = new Map(req.entries.map((e) => [e.name, e]))
    base = req.rerankedNames
      .map((n) => byName.get(n))
      .filter((x): x is PackageDetails => x !== undefined)
  } else {
    base = req.entries
  }

  base = filterBySections(base, req.selectedSections)

  const rows: VisibleRow[] = base.map((e) => ({ entry: e }))
  if (shouldOfferSynthetic(q, req.values, rows)) {
    // Prepended, not appended: the user typed it, so it is the most likely
    // thing they want and must be reachable without scrolling past 100 results.
    rows.unshift({ entry: syntheticEntry(q, req.os, req.arch), isSynthetic: true })
  }
  return rows
}

/**
 * Bucket the flat list for the sticky group headers.
 *
 * Insertion-ordered: the first row's group appears first. That keeps header
 * order consistent with the flat list the keyboard walks, which is why this
 * does NOT sort by the GroupKey enum.
 *
 * The synthetic row gets its own 'User-added' bucket rather than being grouped
 * by name, so it cannot be mistaken for a real indexed package.
 */
export function groupRows(
  rows: VisibleRow[],
): Array<[GroupKey | 'User-added', VisibleRow[]]> {
  const buckets = new Map<GroupKey | 'User-added', VisibleRow[]>()
  for (const row of rows) {
    const g: GroupKey | 'User-added' = row.isSynthetic
      ? 'User-added'
      : groupFor(row.entry.name)
    const bucket = buckets.get(g)
    if (bucket) bucket.push(row)
    else buckets.set(g, [row])
  }
  return Array.from(buckets.entries())
}

export interface SectionFacet {
  section: string
  count: number
}

/**
 * Aggregate section counts over the CURRENT page of entries.
 *
 * Counted from the unfiltered entries on purpose: if the counts came from the
 * filtered list, selecting a facet would drop every other facet to zero and the
 * user could not widen the selection.
 *
 * Sorted by count descending. Ties keep insertion order, which is stable because
 * the server's ordering is.
 */
export function sectionFacets(entries: PackageDetails[]): SectionFacet[] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const key = e.section || '(none)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count)
}
