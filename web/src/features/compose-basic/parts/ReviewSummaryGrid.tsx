import { SummaryPanel } from '@/components/layout/SummaryPanel'
import type { ComposeResponse } from '@/api/types'

/**
 * The two stacked summary tables: Your Selection and Image.
 *
 * ⚠️ `grid-cols-1` WITH NO TWO-COLUMN VARIANT, DELIBERATELY. A Tailwind `xl:`
 * breakpoint is viewport-relative, so on a wide screen it would fire and squeeze
 * two summary tables into a pane the user has dragged to 45% — or 35%, its
 * minimum. (The `@max-pane-*` container variants elsewhere exist precisely to
 * solve that class of bug; here one column is simply right at every width.) This
 * pane holds a review summary rather than a form, and stacked tables read better
 * than side-by-side ones, so there is nothing to make responsive.
 *
 * Rendered only once a review has resolved, so `review` is non-optional here.
 *
 * Extracted from BasicPage via ReviewPane in FE-7c.
 */
export function ReviewSummaryGrid({ review }: { review: ComposeResponse }) {
  return (
    <div className="grid grid-cols-1 gap-3 text-sm">
      <SummaryPanel
        heading="Your Selection"
        rows={
          [
            ['Vertical', review.summary.vertical],
            review.summary.sku ? ['SKU', review.summary.sku] : null,
            ['Platform', review.summary.platform],
            ['OS', review.summary.os],
            ['Image Type', review.summary.imageType.toUpperCase()],
          ] as ([string, string] | null)[]
        }
      />
      <SummaryPanel
        heading="Image Configuration"
        rows={
          [
            ['Image', `${review.summary.imageName}${review.summary.imageVersion ? ` (v${review.summary.imageVersion})` : ''}`],
            review.summary.description ? ['Description', review.summary.description] : null,
            ['Architecture', review.summary.architecture],
            review.summary.kernelVersion ? ['Kernel', review.summary.kernelVersion] : null,
            ['Packages', `${review.summary.packageCount} packages`],
            review.summary.diskSize ? ['Disk', `${review.summary.diskSize}${review.summary.partitionTable ? `, ${review.summary.partitionTable.toUpperCase()}` : ''}${review.summary.partitionCount ? `, ${review.summary.partitionCount} partitions` : ''}`] : null,
            review.summary.hostname ? ['Hostname', review.summary.hostname] : null,
          ] as ([string, string] | null)[]
        }
      />
    </div>
  )
}
