import type { PackageDetails } from '@/api/types'
import { Highlighted } from './Highlighted'
import { SectionBlock } from './SectionBlock'
import { KV } from './KV'
import {
  PopularitySection,
  HomepageSection,
  ProvidesSection,
  TagsSection,
  DependenciesSection,
  DescriptionSection,
} from './DetailSections'

/**
 * The detail pane: package name, identity table, then six optional sections.
 *
 * A thin composition — this was 157 lines at complexity 35, driven by six
 * independent `rec.x && (...)` guards nested in one tree. Each section now owns
 * its own guard (see DetailSections).
 */

export function DetailPane({ rec, query }: { rec: PackageDetails; query: string }) {
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
          {<Highlighted text={rec.name} query={query} />}
        </div>
        {(rec.summary || rec.description) && (
          <div style={{ fontSize: 13, color: 'var(--font-color)', marginTop: 4 }}>
            {<Highlighted text={rec.summary || rec.description.split('\n')[0]} query={query} />}
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

      <PopularitySection rec={rec} />
      <HomepageSection rec={rec} />
      <ProvidesSection rec={rec} />
      <TagsSection rec={rec} />
      <DependenciesSection rec={rec} />
      <DescriptionSection rec={rec} query={query} />
    </div>
  )
}
