import { Card } from '@/components/layout/Card'
import { BuildMetadataList } from './BuildMetadataList'
import { CommandBlock } from './CommandBlock'
import { TemplateRow } from './TemplateRow'
import type { BuildDetails } from '@/api/types'

/**
 * Collapsible post-mortem card: the exact command, the template file, and
 * either the Jenkins coordinates (dispatched path) or the local work/cache
 * dirs (in-process path). Never both — `details.jenkins` is the discriminator.
 *
 * Collapsed by default and deliberately so: the log is what an operator wants
 * on arrival, details are for after something went wrong. Uses the standard
 * accordion Card, the same one the Interactive tab's sections use, so the
 * visual language stays consistent across the app.
 *
 * The command `<pre>` is hard-coded #1e1e1e / #d4d4d4 rather than themed. That
 * is intentional and matches the terminal and the YAML editor — the three
 * "code surfaces" stay one visual family in BOTH app themes. Do not swap these
 * for `var(--…)` tokens.
 *
 * `api.templateUrl(buildId)` is the download href; it goes through the API
 * client so the BASE prefix is applied. (BuildView's artifact URL does not —
 * recorded as a latent defect, not fixed here.)
 *
 * Extracted verbatim from BuildView.
 */
export function BuildDetailsCard({
  details,
  buildId,
  copyCommand,
}: {
  details: BuildDetails
  buildId: string
  /** Writes `details.command` to the clipboard. Owned by the parent because
   *  the toast it may raise is a page-level concern. */
  copyCommand: () => void
}) {
  return (
    <Card
      title="Build details"
      titleStyle="section"
      collapsible
      defaultCollapsed
      className="flex-none"
    >
      <div className="space-y-4 text-xs">
        <CommandBlock command={details.command} copyCommand={copyCommand} />
        <TemplateRow template={details.template} buildId={buildId} />
        <BuildMetadataList details={details} />
      </div>
    </Card>
  )
}
