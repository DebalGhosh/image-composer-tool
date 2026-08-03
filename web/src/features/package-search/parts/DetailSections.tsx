import type { PackageDetails } from '@/api/types'
import { popconBarWidth } from '../model/format'
import { Highlighted } from './Highlighted'
import { SectionBlock } from './SectionBlock'
import { TagChips } from './TagChips'

/**
 * The detail pane's six optional sections.
 *
 * Split out of DetailPane, which reached 157 lines and COMPLEXITY 35 — more than
 * double the ceiling. The complexity came from six independent `rec.x && (...)`
 * guards nested in one JSX tree; one component per section makes each guard a
 * single early return instead.
 *
 * Every section renders NOTHING when its data is absent — pkgsvc omits fields it
 * has no data for, and an empty "Homepage" heading is worse than no heading.
 */

export function PopularitySection({ rec }: { rec: PackageDetails }) {
  return (
    <>
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

    </>
  )
}

export function HomepageSection({ rec }: { rec: PackageDetails }) {
  return (
    <>
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

    </>
  )
}

export function ProvidesSection({ rec }: { rec: PackageDetails }) {
  const provides = rec.provides
  return (
    <>
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

    </>
  )
}

export function TagsSection({ rec }: { rec: PackageDetails }) {
  return (
    <>
    {/* Tags & categories */}
    {(rec.tags?.length || rec.categories?.length || rec.keywords?.length) && (
      <SectionBlock label="Tags & categories">
        <TagChips items={rec.categories ?? []} tone="strong" />
        <TagChips items={rec.tags ?? []} tone="normal" />
        <TagChips items={rec.keywords ?? []} tone="muted" />
      </SectionBlock>
    )}

    </>
  )
}

export function DependenciesSection({ rec }: { rec: PackageDetails }) {
  return (
    <>
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

    </>
  )
}

export function DescriptionSection({
  rec,
  query,
}: {
  rec: PackageDetails
  query: string
}) {
  return (
    <>
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
          {<Highlighted text={rec.description} query={query} />}
        </div>
      </SectionBlock>
    )}
    </>
  )
}
