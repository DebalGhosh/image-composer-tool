import { Card } from '@/components/layout/Card'

/**
 * Read-only summary of the sections parsed out of a seed but not yet exposed in
 * the form.
 *
 * These are ROUND-TRIP CARRIERS: the draft holds them verbatim so a Build after
 * an Interactive edit preserves them, and the Advanced tab is where they are
 * actually editable. Showing the counts is what stops a user assuming they were
 * dropped.
 */
export function InheritedSection({
  configurationCount,
  repositoryCount,
}: {
  configurationCount: number
  repositoryCount: number
}) {
  return (
              <Card
                title="Inherited from seed"
                titleStyle="section"
                collapsible
                defaultCollapsed
                className="mb-4"
              >
                <p
                  className="text-xs"
                  style={{ color: 'var(--muted-color)' }}
                >
                  {configurationCount} shell step
                  {configurationCount === 1 ? '' : 's'}{' '}
                  inherited from seed — edit in Advanced.
                </p>
                <p
                  className="mt-1 text-xs"
                  style={{ color: 'var(--muted-color)' }}
                >
                  {repositoryCount} package repositor
                  {repositoryCount === 1 ? 'y' : 'ies'}{' '}
                  inherited from seed — edit in Advanced.
                </p>
              </Card>
  )
}
