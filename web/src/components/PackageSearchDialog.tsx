/**
 * PackageSearchDialog — the expanded, palette-style package picker that
 * opens over the Interactive tab's inline combobox. Design inspiration is
 * the Intel Smart Software Factory UI project's DialogWrapper (dim +
 * slide-in), layered with search-palette conventions from Linear /
 * Raycast / GitHub Cmd+K.
 *
 * Layout — a wide two-column dialog:
 *   Left column  (55%): search input + selected chips strip + facet chips
 *                       + grouped, keyboard-navigable result list
 *   Right column (45%): live detail pane for the currently-highlighted row
 *   Footer:            sticky kbd shortcut legend
 *
 * Same `values / onChange / os / arch` contract as PackageSearchCombobox,
 * so a package added here shows up in the inline chip list below the
 * input as soon as the dialog closes, and vice versa. State is entirely
 * scoped to this component — no store writes beyond the parent's own
 * onChange.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MiniSearch from 'minisearch'
import { api, ApiError } from '../api/client'
import type { PackageDetails } from '../api/types'
import { DialogOverlay } from './DialogOverlay'
import {
  DEBOUNCE_MS,
  MINISEARCH_OPTIONS,
  PKG_NAME_RE,
  SEARCH_LIMIT,
  groupFor,
  normalizeArch,
} from './packageSearchShared'
import type { GroupKey } from './packageSearchShared'

// ---- props -----------------------------------------------------------

export interface PackageSearchDialogProps {
  open: boolean
  onClose: () => void
  values: string[]
  onChange: (next: string[]) => void
  os: string
  arch: string
}

// ---- MiniSearch doc shape --------------------------------------------

interface PackageDoc extends PackageDetails {
  id: string
}

function toDoc(e: PackageDetails): PackageDoc {
  return { ...e, id: e.name }
}

// ---- recent searches -------------------------------------------------

const RECENTS_KEY = 'ict.packagesearch.recents'
const RECENTS_CAP = 10

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_CAP)
      : []
  } catch {
    return []
  }
}

function pushRecent(q: string): string[] {
  const trimmed = q.trim()
  if (trimmed.length < 2) return loadRecents() // don't cache one-char noise
  const current = loadRecents().filter((r) => r !== trimmed)
  const next = [trimmed, ...current].slice(0, RECENTS_CAP)
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* quota exceeded, private-browsing edge — silent-degrade */
  }
  return next
}

// ---- highlighting ----------------------------------------------------

// Highlight every case-insensitive occurrence of the query tokens inside
// `text` with a <mark>. Returns a React fragment. Tokens are split on
// whitespace so "machine learning" highlights both words independently.
function highlight(text: string, q: string): React.ReactNode {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return text
  // Build a single regex OR of the tokens. Escape regex-y chars in each.
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp('(' + escaped.join('|') + ')', 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        // odd indices are captures — highlight them.
        i % 2 === 1 ? (
          <mark
            key={i}
            style={{
              background: 'color-mix(in srgb, var(--classic-blue) 25%, transparent)',
              color: 'inherit',
              padding: '0 1px',
              borderRadius: 2,
            }}
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

// ---- selection helper -----------------------------------------------

function toggleValue(values: string[], name: string): string[] {
  return values.includes(name) ? values.filter((v) => v !== name) : [...values, name]
}

// ---- popcon formatting -----------------------------------------------

function formatInst(n: number | undefined): string {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k'
  return String(n)
}

// Popcon bar is log-scaled against an anchor of 100k installs (Ubuntu
// noble's rough "well-installed" median). Values above the anchor
// saturate the bar; values at 0 render an empty bar.
function popconBarWidth(inst: number | undefined): number {
  if (!inst || inst <= 0) return 0
  const anchor = 100_000
  const w = Math.log1p(inst) / Math.log1p(anchor)
  return Math.min(1, w) * 100
}

// ---- kbd chip --------------------------------------------------------

function KbdChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 4,
        border: '1px solid var(--border-color)',
        background: 'var(--input-background)',
        color: 'var(--font-color)',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        minWidth: 18,
        justifyContent: 'center',
        lineHeight: 1.4,
      }}
    >
      {children}
    </kbd>
  )
}

// =====================================================================
// Main component
// =====================================================================

export function PackageSearchDialog({
  open,
  onClose,
  values,
  onChange,
  os,
  arch,
}: PackageSearchDialogProps) {
  // --- search state ---------------------------------------------------
  const [searchQuery, setSearchQuery] = useState('')
  const [entries, setEntries] = useState<PackageDetails[]>([])
  const [loading, setLoading] = useState(false)
  const [indexMissing, setIndexMissing] = useState(false)
  const [selectedSections, setSelectedSections] = useState<string[]>([])
  const [focusIdx, setFocusIdx] = useState(0)
  const [detailFocused, setDetailFocused] = useState(false)
  const [recents, setRecents] = useState<string[]>(() => loadRecents())

  // Cache full-detail records the server has already returned for
  // rows the user has focused. Session-lived; cleared on unmount.
  const detailCacheRef = useRef<Map<string, PackageDetails>>(new Map())

  // Stale-response guard: each fetch increments this and pins the
  // starting id; late responses whose id has been overtaken are
  // dropped.
  const fetchIdRef = useRef(0)
  // AbortController for the in-flight fetch — improvement over the
  // inline combobox, which only guards via the id ref (fetch still
  // fires needlessly).
  const abortRef = useRef<AbortController | null>(null)

  // --- fetch loop -----------------------------------------------------
  useEffect(() => {
    if (!open) return
    if (!os) {
      setEntries([])
      return
    }
    const q = searchQuery.trim()
    const id = ++fetchIdRef.current
    setLoading(true)
    const handle = window.setTimeout(() => {
      // Cancel any prior in-flight fetch; the last-wins policy makes
      // rapid keystrokes stop hammering the microservice.
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      api
        .searchPackagesFull({ os, arch: normalizeArch(arch), q, limit: SEARCH_LIMIT })
        .then((res) => {
          if (id !== fetchIdRef.current) return
          setEntries(res.packages ?? [])
          setLoading(false)
          setFocusIdx(0)
          setIndexMissing(res.total === 0 && q === '' && (res.packages?.length ?? 0) === 0)
        })
        .catch((err) => {
          if (id !== fetchIdRef.current) return
          // The AbortController surface throws either DOMException named
          // AbortError or an ApiError; either way we drop silently.
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (err instanceof ApiError && err.status === 0) return
          // Non-abort failures: keep the last entries visible so the
          // user isn't blank-slated on a transient blip; just log.
          // eslint-disable-next-line no-console
          console.warn('[PackageSearchDialog] search failed:', err)
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, searchQuery, os, arch])

  // Reset on close so a fresh open lands on a clean slate.
  useEffect(() => {
    if (!open) {
      setSearchQuery('')
      setSelectedSections([])
      setFocusIdx(0)
      setDetailFocused(false)
      detailCacheRef.current.clear()
    }
  }, [open])

  // --- MiniSearch reindex --------------------------------------------
  const miniSearch = useMemo(() => {
    const ms = new MiniSearch<PackageDoc>({
      fields: MINISEARCH_OPTIONS.fields,
      storeFields: MINISEARCH_OPTIONS.storeFields,
      searchOptions: MINISEARCH_OPTIONS.searchOptions,
      extractField: (doc, fieldName) => {
        const raw = (doc as unknown as Record<string, unknown>)[fieldName]
        if (Array.isArray(raw)) return raw.join(' ')
        return raw == null ? '' : String(raw)
      },
    })
    ms.addAll(entries.map(toDoc))
    return ms
  }, [entries])

  // --- filter + sort into a flat visible list -----------------------
  // Flow: entries → MiniSearch rerank (if q>=2) → section-facet filter
  // → group buckets. The flat visible list drives keyboard nav; a
  // parallel `groups` structure drives the sticky headers.
  interface VisibleRow {
    entry: PackageDetails
    isSynthetic?: boolean // '+ Add "…"' row
  }

  const visible: VisibleRow[] = useMemo(() => {
    const q = searchQuery.trim()
    let base: PackageDetails[]
    if (q.length >= 2 && entries.length > 0) {
      const byName = new Map(entries.map((e) => [e.name, e]))
      base = miniSearch
        .search(q)
        .map((r) => byName.get(r.id as string))
        .filter((x): x is PackageDetails => x !== undefined)
    } else {
      base = entries
    }
    // Section-facet filter (multi-select union — clicking two sections
    // widens the visible list to their union).
    if (selectedSections.length > 0) {
      const wanted = new Set(selectedSections)
      base = base.filter((e) => wanted.has(e.section || '(none)'))
    }
    const rows: VisibleRow[] = base.map((e) => ({ entry: e }))
    // Prepend synthetic + Add row when the query is a valid pkg name
    // and isn't already surfaced or already selected.
    if (
      q.length > 0 &&
      PKG_NAME_RE.test(q) &&
      !values.includes(q) &&
      !rows.some((r) => r.entry.name === q)
    ) {
      rows.unshift({
        entry: {
          name: q,
          version: '',
          description: 'User-added — will be included verbatim',
          arch: normalizeArch(arch),
          section: '(user-added)',
          repository: '',
          os,
          type: 'deb',
        },
        isSynthetic: true,
      })
    }
    return rows
  }, [entries, miniSearch, searchQuery, selectedSections, values, os, arch])

  // Groups derived from the visible flat list — order is by group-key
  // enum, preserving what users expect from the inline combobox.
  const groups = useMemo(() => {
    const buckets = new Map<GroupKey | 'User-added', VisibleRow[]>()
    for (const row of visible) {
      const g: GroupKey | 'User-added' = row.isSynthetic
        ? 'User-added'
        : groupFor(row.entry.name)
      const bucket = buckets.get(g)
      if (bucket) bucket.push(row)
      else buckets.set(g, [row])
    }
    return Array.from(buckets.entries())
  }, [visible])

  // Section facet aggregation over the CURRENT page — top 5 by count.
  const sectionFacets: Array<{ section: string; count: number }> = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) {
      const key = e.section || '(none)'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([section, count]) => ({ section, count }))
      .sort((a, b) => b.count - a.count)
  }, [entries])

  // --- detail record: prefer in-response full data, fall back to a
  //     one-off fetch. Cached per session so repeat focuses don't
  //     round-trip.
  const focusedEntry: PackageDetails | undefined = visible[focusIdx]?.entry
  const [detailRec, setDetailRec] = useState<PackageDetails | undefined>()
  useEffect(() => {
    if (!focusedEntry || focusedEntry.name === '') {
      setDetailRec(undefined)
      return
    }
    // In-page enriched shape already has the fields we need.
    // Nevertheless, if certain enriched fields (homepage, popularity,
    // provides) are missing AND we haven't yet fetched them, kick off
    // a details fetch. The single-record endpoint is O(1) on pkgsvc's
    // side.
    const hasEnriched =
      focusedEntry.homepage !== undefined ||
      focusedEntry.popularity !== undefined ||
      (focusedEntry.provides && typeof focusedEntry.provides === 'object')
    setDetailRec(focusedEntry)
    if (hasEnriched || focusedEntry.section === '(user-added)') return
    const cached = detailCacheRef.current.get(focusedEntry.name)
    if (cached) {
      setDetailRec(cached)
      return
    }
    // Fire a fetch — swallow errors, keep the base entry visible.
    let cancelled = false
    api
      .packageDetails(focusedEntry.os, focusedEntry.arch, focusedEntry.name)
      .then((rec) => {
        if (cancelled) return
        detailCacheRef.current.set(focusedEntry.name, rec)
        setDetailRec(rec)
      })
      .catch(() => {
        /* detail unavailable — pane still renders what we have. */
      })
    return () => {
      cancelled = true
    }
  }, [focusedEntry?.name, focusedEntry?.os, focusedEntry?.arch])

  // Prefetch on hover — cheap warmup so keyboard nav feels instant.
  const prefetchDetails = useCallback(
    (entry: PackageDetails) => {
      if (entry.section === '(user-added)') return
      if (detailCacheRef.current.has(entry.name)) return
      // Fire-and-forget; the useEffect above will read cache on focus.
      api.packageDetails(entry.os, entry.arch, entry.name).then(
        (rec) => detailCacheRef.current.set(entry.name, rec),
        () => {},
      )
    },
    [],
  )

  // --- keyboard nav ---------------------------------------------------
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Cmd/Ctrl+Enter closes after applying the current toggle.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (focusedEntry) {
          onChange(toggleValue(values, focusedEntry.name))
          pushRecent(searchQuery)
        }
        onClose()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusedEntry) {
          onChange(toggleValue(values, focusedEntry.name))
          const nextRecents = pushRecent(searchQuery)
          setRecents(nextRecents)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) =>
          visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length,
        )
        return
      }
      if (e.key === 'PageDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(visible.length - 1, i + 10))
        return
      }
      if (e.key === 'PageUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(0, i - 10))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setFocusIdx(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        setFocusIdx(Math.max(0, visible.length - 1))
        return
      }
      if (e.key === 'ArrowRight') {
        // If the caret isn't at the end of the input, let the browser
        // handle it — otherwise focus the detail pane.
        const input = e.currentTarget
        if (
          input.selectionStart === input.value.length &&
          input.selectionEnd === input.value.length
        ) {
          e.preventDefault()
          setDetailFocused(true)
        }
        return
      }
    },
    [focusedEntry, values, onChange, onClose, searchQuery, visible.length],
  )

  // If focus is on the detail pane, ArrowLeft returns to the list.
  const onDetailKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      // Escape reaches DialogOverlay's document-level listener too, but
      // we want ArrowLeft/Left specifically to return focus, not close.
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setDetailFocused(false)
      }
    }
  }, [])

  // Scroll focused row into view as it changes.
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row-idx="${focusIdx}"]`,
    )
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusIdx])

  // Ensure the input keeps real focus when the list is active — the
  // aria-activedescendant pattern moves *virtual* focus onto rows.
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (open && !detailFocused) {
      // Return focus to input after any row toggle re-render.
      const el = inputRef.current
      if (el && document.activeElement !== el) el.focus()
    }
  }, [open, detailFocused, values])

  // Focus the detail pane when detailFocused flips true.
  const detailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (detailFocused) detailRef.current?.focus()
    else inputRef.current?.focus()
  }, [detailFocused])

  // --- render ---------------------------------------------------------
  return (
    <DialogOverlay
      open={open}
      onClose={onClose}
      title="Packages"
      ariaLabelledBy="pkgsearch-title"
      size="wide"
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {/* Body: two-column layout */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '55fr 45fr',
            minHeight: 0,
            flex: 1,
          }}
        >
          {/* ================= LEFT column ================= */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              borderRight: '1px solid var(--border-color)',
            }}
          >
            {/* Search input row */}
            <div style={{ padding: '14px 16px 8px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ position: 'relative' }}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--muted-color)',
                    pointerEvents: 'none',
                  }}
                >
                  <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M14 14l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  data-autofocus
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="pkgsearch-list"
                  aria-activedescendant={
                    visible.length > 0 && !detailFocused
                      ? `pkgsearch-row-${focusIdx}`
                      : undefined
                  }
                  aria-autocomplete="list"
                  placeholder="Search 139,000+ packages…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  style={{
                    width: '100%',
                    padding: '10px 12px 10px 36px',
                    fontSize: 14,
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--input-background)',
                    color: 'var(--font-color)',
                    outline: 'none',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'var(--classic-blue)'
                    e.currentTarget.style.boxShadow =
                      '0 0 0 3px color-mix(in srgb, var(--classic-blue) 20%, transparent)'
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border-color)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                />
              </div>

              {/* Live result-count region for a11y */}
              <div
                aria-live="polite"
                role="status"
                style={{
                  fontSize: 11,
                  color: 'var(--muted-color)',
                  marginTop: 8,
                  minHeight: 16,
                }}
              >
                {loading
                  ? 'Searching…'
                  : entries.length > 0
                    ? `${visible.length} of ${entries.length} results`
                    : searchQuery.length > 0
                      ? 'No matches'
                      : ''}
              </div>

              {/* Selected chips strip */}
              {values.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 8,
                    alignItems: 'center',
                  }}
                >
                  {values.map((v) => (
                    <span
                      key={v}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 4px 3px 8px',
                        borderRadius: 999,
                        background: 'color-mix(in srgb, var(--classic-blue) 12%, var(--section-background))',
                        border: '1px solid color-mix(in srgb, var(--classic-blue) 30%, var(--border-color))',
                        color: 'var(--font-color)',
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {v}
                      <button
                        type="button"
                        onClick={() => onChange(values.filter((x) => x !== v))}
                        aria-label={`Remove ${v}`}
                        style={{
                          appearance: 'none',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--muted-color)',
                          padding: 2,
                          display: 'inline-flex',
                          borderRadius: 4,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = 'var(--danger)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = 'var(--muted-color)'
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </span>
                  ))}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: 'var(--muted-color)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <strong style={{ color: 'var(--font-color)', fontWeight: 600 }}>
                      {values.length}
                    </strong>{' '}
                    selected
                    {values.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onChange([])}
                        style={{
                          appearance: 'none',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--muted-color)',
                          textDecoration: 'underline',
                          fontSize: 11,
                        }}
                      >
                        Clear all
                      </button>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* Facet chips */}
            {sectionFacets.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--border-color)',
                  overflowX: 'auto',
                }}
              >
                <FacetChip
                  active={selectedSections.length === 0}
                  onClick={() => setSelectedSections([])}
                  label="all"
                  count={entries.length}
                />
                {sectionFacets.slice(0, 6).map(({ section, count }) => (
                  <FacetChip
                    key={section}
                    active={selectedSections.includes(section)}
                    onClick={() =>
                      setSelectedSections((prev) =>
                        prev.includes(section)
                          ? prev.filter((s) => s !== section)
                          : [...prev, section],
                      )
                    }
                    label={section}
                    count={count}
                  />
                ))}
                {sectionFacets.length > 6 && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      fontSize: 11,
                      color: 'var(--muted-color)',
                      padding: '2px 6px',
                    }}
                  >
                    +{sectionFacets.length - 6} more
                  </span>
                )}
              </div>
            )}

            {/* Result list */}
            <div
              ref={listRef}
              id="pkgsearch-list"
              role="listbox"
              aria-multiselectable="true"
              aria-label="Package results"
              style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}
            >
              {loading && entries.length === 0 ? (
                <SkeletonRows />
              ) : visible.length === 0 && searchQuery.trim().length > 0 ? (
                <EmptyState
                  query={searchQuery}
                  onAddManually={
                    PKG_NAME_RE.test(searchQuery.trim())
                      ? () => {
                          const q = searchQuery.trim()
                          onChange(toggleValue(values, q))
                          setSearchQuery('')
                        }
                      : undefined
                  }
                />
              ) : visible.length === 0 && searchQuery.trim().length === 0 ? (
                <IdleState
                  indexMissing={indexMissing}
                  recents={recents}
                  onPick={(q) => setSearchQuery(q)}
                />
              ) : (
                (() => {
                  let flat = -1
                  return groups.map(([groupKey, rows]) => (
                    <div key={groupKey}>
                      <div
                        style={{
                          position: 'sticky',
                          top: 0,
                          zIndex: 1,
                          background: 'var(--section-background)',
                          padding: '6px 16px',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: 'var(--muted-color)',
                          borderBottom: '1px solid var(--border-color)',
                        }}
                      >
                        {groupKey} <span style={{ fontWeight: 400 }}>({rows.length})</span>
                      </div>
                      {rows.map((row) => {
                        flat += 1
                        const idx = flat
                        const selected = values.includes(row.entry.name)
                        const isFocus = idx === focusIdx && !detailFocused
                        return (
                          <div
                            id={`pkgsearch-row-${idx}`}
                            key={row.entry.name + '@' + idx}
                            role="option"
                            aria-selected={selected}
                            data-row-idx={idx}
                            onMouseDown={(e) => {
                              // Preserve input focus for aria-activedescendant.
                              e.preventDefault()
                              setFocusIdx(idx)
                              onChange(toggleValue(values, row.entry.name))
                            }}
                            onMouseEnter={() => {
                              setFocusIdx(idx)
                              prefetchDetails(row.entry)
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              padding: '8px 16px 8px 12px',
                              borderLeft: isFocus
                                ? '3px solid var(--classic-blue)'
                                : '3px solid transparent',
                              background: isFocus
                                ? 'color-mix(in srgb, var(--classic-blue) 8%, transparent)'
                                : 'transparent',
                              cursor: 'pointer',
                              transition: 'background 120ms ease',
                            }}
                          >
                            <div
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 3,
                                border: '1.5px solid ' + (selected ? 'var(--classic-blue)' : 'var(--muted-color)'),
                                background: selected ? 'var(--classic-blue)' : 'transparent',
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginTop: 2,
                              }}
                            >
                              {selected && (
                                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                                  <path d="M1.5 4l2 2 3-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 13,
                                  color: 'var(--font-color)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {row.isSynthetic ? (
                                  <>
                                    <span style={{ color: 'var(--classic-blue)', fontWeight: 600 }}>+ Add </span>
                                    <span>"{row.entry.name}"</span>
                                  </>
                                ) : (
                                  highlight(row.entry.name, searchQuery)
                                )}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted-color)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  marginTop: 2,
                                }}
                              >
                                {highlight(row.entry.description || row.entry.version || '', searchQuery)}
                              </div>
                            </div>
                            {row.entry.popularity && row.entry.popularity.inst > 0 && (
                              <span
                                title={row.entry.popularity.inst + ' installs (popcon)'}
                                style={{
                                  fontSize: 10,
                                  fontFamily: 'var(--font-mono)',
                                  color: 'var(--muted-color)',
                                  padding: '2px 6px',
                                  borderRadius: 999,
                                  background: 'color-mix(in srgb, var(--muted-color) 10%, transparent)',
                                  border: '1px solid var(--border-color)',
                                  flexShrink: 0,
                                  marginTop: 2,
                                }}
                              >
                                {formatInst(row.entry.popularity.inst)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))
                })()
              )}
            </div>
          </div>

          {/* ================= RIGHT column — detail pane ================= */}
          <div
            ref={detailRef}
            tabIndex={-1}
            data-focus-trap-ignore
            onKeyDown={onDetailKeyDown}
            style={{
              overflowY: 'auto',
              padding: '16px 20px',
              outline: 'none',
              // Subtle highlight when the pane owns focus.
              boxShadow: detailFocused
                ? 'inset 3px 0 0 var(--classic-blue)'
                : 'inset 0 0 0 transparent',
              transition: 'box-shadow 160ms ease',
            }}
          >
            {detailRec ? (
              <DetailPane rec={detailRec} query={searchQuery} />
            ) : (
              <div
                style={{
                  color: 'var(--muted-color)',
                  fontSize: 12,
                  padding: '40px 16px',
                  textAlign: 'center',
                }}
              >
                Highlight a package to see its details.
              </div>
            )}
          </div>
        </div>

        {/* ================= Footer legend ================= */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '8px 18px',
            borderTop: '1px solid var(--border-color)',
            background: 'color-mix(in srgb, var(--muted-color) 4%, var(--section-background))',
            fontSize: 11,
            color: 'var(--muted-color)',
            flex: 'none',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <KbdChip>↑</KbdChip>
            <KbdChip>↓</KbdChip> nav
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <KbdChip>→</KbdChip> detail
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <KbdChip>Enter</KbdChip> toggle
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <KbdChip>⌘⏎</KbdChip> close
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <KbdChip>Esc</KbdChip> close
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {os}·{normalizeArch(arch)} · pkgsvc
          </span>
        </div>
      </div>
    </DialogOverlay>
  )
}

// ---------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------

function FacetChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid ' + (active ? 'var(--classic-blue)' : 'var(--border-color)'),
        background: active
          ? 'color-mix(in srgb, var(--classic-blue) 15%, var(--section-background))'
          : 'var(--input-background)',
        color: active ? 'var(--classic-blue)' : 'var(--font-color)',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      {label}
      <span style={{ color: 'var(--muted-color)', fontWeight: 400 }}>· {count}</span>
    </button>
  )
}

function SkeletonRows() {
  return (
    <div style={{ padding: '8px 16px' }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 0' }}>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--muted-color) 15%, transparent)',
              animation: 'skeleton-pulse 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.06}s`,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: `${50 + ((i * 7) % 30)}%`,
                height: 12,
                borderRadius: 4,
                background: 'color-mix(in srgb, var(--muted-color) 15%, transparent)',
                animation: 'skeleton-pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.06}s`,
              }}
            />
            <div
              style={{
                width: `${30 + ((i * 11) % 40)}%`,
                height: 10,
                marginTop: 4,
                borderRadius: 4,
                background: 'color-mix(in srgb, var(--muted-color) 10%, transparent)',
                animation: 'skeleton-pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.06}s`,
              }}
            />
          </div>
        </div>
      ))}
      <style>{`
        @keyframes skeleton-pulse {
          0%, 100% { opacity: 0.6; }
          50%      { opacity: 1;   }
        }
      `}</style>
    </div>
  )
}

function EmptyState({
  query,
  onAddManually,
}: {
  query: string
  onAddManually?: () => void
}) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: 'var(--font-color)', marginBottom: 8 }}>
        No packages match <strong style={{ fontFamily: 'var(--font-mono)' }}>{query}</strong>.
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted-color)', marginBottom: 16 }}>
        Try a shorter query, or add the package by exact name.
      </div>
      {onAddManually && (
        <button
          type="button"
          onClick={onAddManually}
          style={{
            appearance: 'none',
            padding: '6px 14px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--classic-blue)',
            background: 'transparent',
            color: 'var(--classic-blue)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >
          + Add "{query}" manually
        </button>
      )}
    </div>
  )
}

function IdleState({
  indexMissing,
  recents,
  onPick,
}: {
  indexMissing: boolean
  recents: string[]
  onPick: (q: string) => void
}) {
  if (indexMissing) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 8, fontWeight: 600 }}>
          The package index isn't available.
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted-color)' }}>
          Type a package name and use <em>+ Add "…"</em> to include it verbatim.
        </div>
      </div>
    )
  }
  if (recents.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted-color)' }}>
          Start typing to search 139,000+ packages.
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted-color)', marginTop: 6 }}>
          Try <em>openvino</em>, <em>machine learning</em>, or <em>nginx</em>.
        </div>
      </div>
    )
  }
  return (
    <div style={{ padding: '16px 20px' }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--muted-color)',
          marginBottom: 8,
        }}
      >
        Recent searches
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {recents.slice(0, 5).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onPick(r)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 4,
              border: '1px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--font-color)',
              textAlign: 'left',
              fontSize: 13,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background =
                'color-mix(in srgb, var(--classic-blue) 8%, transparent)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ color: 'var(--muted-color)' }}>
              <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>{r}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function DetailPane({ rec, query }: { rec: PackageDetails; query: string }) {
  const provides = rec.provides
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Name */}
      <div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 18,
            color: 'var(--font-color)',
            fontWeight: 600,
            wordBreak: 'break-word',
          }}
        >
          {highlight(rec.name, query)}
        </div>
        {(rec.summary || rec.description) && (
          <div style={{ fontSize: 13, color: 'var(--font-color)', marginTop: 4 }}>
            {highlight(rec.summary || rec.description.split('\n')[0], query)}
          </div>
        )}
      </div>

      {/* Identity */}
      <SectionBlock label="Identity">
        <KV k="Version" v={rec.version} mono />
        {rec.section && <KV k="Section" v={rec.section} />}
        <KV k="Repository" v={rec.repository || `${rec.os} ${rec.release ?? ''}`} />
        {rec.component && <KV k="Component" v={rec.component} />}
        <KV k="Architecture" v={rec.arch} mono />
        {rec.multiArch && <KV k="Multi-Arch" v={rec.multiArch} />}
        {rec.installedSize !== undefined && rec.installedSize > 0 && (
          <KV k="Installed size" v={`${(rec.installedSize / 1024).toFixed(1)} MiB`} />
        )}
      </SectionBlock>

      {/* Popularity — log-scaled bar */}
      {rec.popularity && rec.popularity.inst > 0 && (
        <SectionBlock label="Popularity">
          <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--font-color)' }}>
            {rec.popularity.inst.toLocaleString()} installs
            {rec.popularity.vote > 0 && (
              <span style={{ color: 'var(--muted-color)' }}> · {rec.popularity.vote.toLocaleString()} recent votes</span>
            )}
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--muted-color) 15%, transparent)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${popconBarWidth(rec.popularity.inst)}%`,
                height: '100%',
                background: 'var(--classic-blue)',
                transition: 'width 220ms ease',
              }}
            />
          </div>
        </SectionBlock>
      )}

      {/* Homepage */}
      {rec.homepage && (
        <SectionBlock label="Homepage">
          <a
            href={rec.homepage}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--classic-blue)', fontSize: 12, wordBreak: 'break-all' }}
          >
            {rec.homepage}
          </a>
        </SectionBlock>
      )}

      {/* Provides — grouped by kind */}
      {provides && typeof provides === 'object' && (
        <SectionBlock label="Provides">
          {(['binary', 'library', 'mimetype', 'dbus', 'python'] as const).map((kind) => {
            const list = provides[kind]
            if (!list || list.length === 0) return null
            return (
              <div key={kind} style={{ marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    color: 'var(--muted-color)',
                    marginRight: 6,
                  }}
                >
                  {kind}
                </span>
                <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--font-color)' }}>
                  {list.join(', ')}
                </span>
              </div>
            )
          })}
        </SectionBlock>
      )}

      {/* Tags & categories */}
      {(rec.tags?.length || rec.categories?.length || rec.keywords?.length) && (
        <SectionBlock label="Tags & categories">
          <TagChips items={rec.categories ?? []} tone="strong" />
          <TagChips items={rec.tags ?? []} tone="normal" />
          <TagChips items={rec.keywords ?? []} tone="muted" />
        </SectionBlock>
      )}

      {/* Depends / recommends */}
      {(rec.depends?.length || rec.recommends?.length) && (
        <SectionBlock label="Dependencies">
          {rec.depends?.length ? (
            <>
              <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--muted-color)', marginBottom: 4 }}>
                Depends
              </div>
              <TagChips items={rec.depends} tone="normal" mono />
            </>
          ) : null}
          {rec.recommends?.length ? (
            <>
              <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--muted-color)', margin: '6px 0 4px' }}>
                Recommends
              </div>
              <TagChips items={rec.recommends} tone="muted" mono />
            </>
          ) : null}
        </SectionBlock>
      )}

      {/* Description */}
      {rec.description && (
        <SectionBlock label="Description">
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--font-color)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {highlight(rec.description, query)}
          </div>
        </SectionBlock>
      )}
    </div>
  )
}

function SectionBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--muted-color)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string | undefined; mono?: boolean }) {
  if (!v) return null
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: 'var(--muted-color)', minWidth: 100 }}>{k}</span>
      <span
        style={{
          color: 'var(--font-color)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {v}
      </span>
    </div>
  )
}

function TagChips({
  items,
  tone,
  mono,
}: {
  items: string[]
  tone: 'strong' | 'normal' | 'muted'
  mono?: boolean
}) {
  if (items.length === 0) return null
  const bg =
    tone === 'strong'
      ? 'color-mix(in srgb, var(--classic-blue) 12%, transparent)'
      : tone === 'normal'
        ? 'color-mix(in srgb, var(--muted-color) 10%, transparent)'
        : 'transparent'
  const border =
    tone === 'strong' ? 'color-mix(in srgb, var(--classic-blue) 30%, var(--border-color))' : 'var(--border-color)'
  const color = tone === 'strong' ? 'var(--classic-blue)' : 'var(--font-color)'
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.slice(0, 24).map((t) => (
        <span
          key={t}
          style={{
            display: 'inline-block',
            padding: '2px 6px',
            fontSize: 10,
            fontFamily: mono ? 'var(--font-mono)' : undefined,
            borderRadius: 4,
            background: bg,
            border: '1px solid ' + border,
            color,
          }}
        >
          {t}
        </span>
      ))}
      {items.length > 24 && (
        <span style={{ fontSize: 10, color: 'var(--muted-color)', padding: '2px 4px' }}>
          +{items.length - 24}
        </span>
      )}
    </div>
  )
}
