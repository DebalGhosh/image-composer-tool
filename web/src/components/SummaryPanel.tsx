/**
 * SummaryPanel — the mini key/value table used inside review + build-details
 * cards on the Basic and Build Image tabs. Extracted here so BasicPage and
 * BuildView share one implementation.
 *
 * Rows: [key, value] tuples, or `null` for a row we want to hide (used when
 * an optional summary field is empty). Nulls are filtered inline.
 *
 * Layout: key column is fixed-width (w-32) so labels line up cleanly across
 * both panels; value column stretches (align-top so long descriptions wrap
 * without pulling the key label off the baseline). Rows are separated by a
 * subtle divider in --border-color for readability.
 */
export function SummaryPanel({
  heading,
  rows,
}: {
  heading: string
  rows: ([string, string] | null)[]
}) {
  const cleaned = rows.filter((r): r is [string, string] => r !== null)
  return (
    <div
      className="rounded-md p-4"
      style={{ background: 'var(--page-background)' }}
    >
      <p
        className="mb-3 pb-2 text-sm font-bold uppercase tracking-wide border-b"
        style={{
          color: 'var(--title-text)',
          borderColor: 'var(--border-color)',
        }}
      >
        {heading}
      </p>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {cleaned.map(([k, v], i) => (
            <tr
              key={k}
              className={i === 0 ? '' : 'border-t'}
              style={{ borderColor: 'var(--border-color)' }}
            >
              <td
                className="w-32 py-2 pr-4 align-top font-semibold whitespace-nowrap"
                style={{ color: 'var(--muted-color)' }}
              >
                {k}
              </td>
              <td
                className="py-2 align-top break-words"
                style={{ color: 'var(--font-color)' }}
              >
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
