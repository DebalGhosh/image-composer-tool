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

import { useEffect, useMemo, useRef, useState } from 'react'
import MiniSearch from 'minisearch'
import type { PackageDetails } from '@/api/types'
import { DialogOverlay } from '@/components/layout/DialogOverlay'
import {
  MINISEARCH_OPTIONS,
  PKG_NAME_RE,
  groupFor,
  normalizeArch,
} from './packageSearchShared'
import { loadRecents } from './model/recents'
import { usePackageSearch } from './hooks/usePackageSearch'
import { usePackageDetails } from './hooks/usePackageDetails'
import { useListKeyboardNav } from './hooks/useListKeyboardNav'
import { toggleValue, formatInst } from './model/format'
import { Highlighted } from './parts/Highlighted'
import { KbdChip } from './parts/KbdChip'
import { FacetChip } from './parts/FacetChip'
import { SkeletonRows } from './parts/SkeletonRows'
import { EmptyState } from './parts/EmptyState'
import { IdleState } from './parts/IdleState'
import { DetailPane } from './parts/DetailPane'
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

export function PackageSearchDialog({
  open,
  onClose,
  values,
  onChange,
  os,
  arch,
}: PackageSearchDialogProps) {
  // --- search state ---------------------------------------------------
  // Nine interdependent useState calls became one reducer; the fetch loop and
  // its TWO stale-response guards live in the hook. See model/searchState and
  // hooks/usePackageSearch.
  const { state, dispatch } = usePackageSearch({ open, os, arch })
  const {
    query: searchQuery,
    entries,
    loading,
    indexMissing,
    selectedSections,
    focusIdx,
    detailFocused,
  } = state
  const [recents, setRecents] = useState<string[]>(() => loadRecents())

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
  //     round-trip. See hooks/usePackageDetails.
  const focusedEntry: PackageDetails | undefined = visible[focusIdx]?.entry
  const { detailRec, prefetchDetails, clearCache } = usePackageDetails(focusedEntry)

  // Drop the detail cache when the dialog closes.
  useEffect(() => {
    if (!open) clearCache()
  }, [open, clearCache])


  // Keyboard navigation — see hooks/useListKeyboardNav for the full key map.
  const { onInputKeyDown, onDetailKeyDown } = useListKeyboardNav({
    focusedEntry,
    values,
    onChange,
    onClose,
    searchQuery,
    visibleCount: visible.length,
    dispatch,
    setRecents,
  })

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
                  onChange={(e) => dispatch({ type: 'queryChanged', query: e.target.value })}
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
                  onClick={() => dispatch({ type: 'sectionsCleared' })}
                  label="all"
                  count={entries.length}
                />
                {sectionFacets.slice(0, 6).map(({ section, count }) => (
                  <FacetChip
                    key={section}
                    active={selectedSections.includes(section)}
                    onClick={() => dispatch({ type: 'sectionToggled', section })}
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
                          dispatch({ type: 'queryChanged', query: '' })
                        }
                      : undefined
                  }
                />
              ) : visible.length === 0 && searchQuery.trim().length === 0 ? (
                <IdleState
                  indexMissing={indexMissing}
                  recents={recents}
                  onPick={(q) => dispatch({ type: 'queryChanged', query: q })}
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
                              dispatch({ type: 'focusSet', index: idx })
                              onChange(toggleValue(values, row.entry.name))
                            }}
                            onMouseEnter={() => {
                              dispatch({ type: 'focusSet', index: idx })
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
                                  <Highlighted text={row.entry.name} query={searchQuery} />
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
                                {<Highlighted text={row.entry.description || row.entry.version || ''} query={searchQuery} />}
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
