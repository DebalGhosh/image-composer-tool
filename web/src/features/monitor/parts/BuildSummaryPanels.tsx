import { SummaryPanel } from '@/components/layout/SummaryPanel'
import type { ComposeSummary } from '@/api/types'

/**
 * The Selection / Image summary pair.
 *
 * Only Basic-tab dispatches carry a summary; Interactive and Advanced send raw
 * YAML and leave it unset, so the parent gates on `details?.summary` and this
 * component can take a non-optional one. The section simply does not render on
 * those paths.
 *
 * ⚠️ THE `@max-pane-4col:` PREFIX IS A CONTAINER QUERY, NOT A VIEWPORT ONE, and
 * it resolves against the PANE marked `@container` in BuildView — not against
 * this component. Do not add a `@container` class here to "make it
 * self-contained": that would make this element its own reference box, break
 * the intended breakpoint, and create a stacking context (see
 * .claude/UI-LAYOUT.md). The marker count must stay at exactly 3.
 *
 * The pane can be dragged to ~30% of a 1280 viewport, which is why a viewport
 * query was wrong here: it would still report `xl` while the pane was 384px and
 * cheerfully halve it again.
 *
 * Extracted verbatim from BuildView; `details.summary` renamed to `summary`.
 */
export function BuildSummaryPanels({ summary }: { summary: ComposeSummary }) {
  return (
    <div className="@max-pane-4col:grid-cols-1 grid flex-none grid-cols-2 gap-3">
      <SummaryPanel
        heading="Selection"
        rows={
          [
            ['Vertical', summary.vertical],
            summary.sku ? ['SKU', summary.sku] : null,
            ['Platform', summary.platform],
            ['OS', summary.os],
            ['Image Type', summary.imageType.toUpperCase()],
          ] as ([string, string] | null)[]
        }
      />
      <SummaryPanel
        heading="Image"
        rows={
          [
            [
              'Name',
              summary.imageName +
                (summary.imageVersion
                  ? ' (v' + summary.imageVersion + ')'
                  : ''),
            ],
            summary.description
              ? ['Description', summary.description]
              : null,
            ['Architecture', summary.architecture],
            summary.kernelVersion
              ? ['Kernel', summary.kernelVersion]
              : null,
            ['Packages', summary.packageCount + ' packages'],
            summary.diskSize
              ? [
                  'Disk',
                  summary.diskSize +
                    (summary.partitionTable
                      ? ', ' +
                        summary.partitionTable.toUpperCase()
                      : '') +
                    (summary.partitionCount
                      ? ', ' +
                        summary.partitionCount +
                        ' partitions'
                      : ''),
                ]
              : null,
            summary.hostname
              ? ['Hostname', summary.hostname]
              : null,
          ] as ([string, string] | null)[]
        }
      />
    </div>
  )
}
