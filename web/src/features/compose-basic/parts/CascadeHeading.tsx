/**
 * The left pane's title and one-line explanation.
 *
 * Static copy, extracted so BasicPage's own body reads as layout and state
 * rather than prose. `--title-text` goes through an inline style and
 * `--muted-color` through a Tailwind arbitrary value — inconsistent, but that is
 * how it was written and changing it is a styling decision, not a refactor.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function CascadeHeading() {
  return (
    <>
      <h1
        className="mb-1 text-2xl font-bold"
        style={{ color: 'var(--title-text)' }}
      >
        Choose Image Configuration
      </h1>
      <p className="mb-5 text-sm text-[var(--muted-color)]">
        Select a targeted vertical, SKU, and platform. Pre-configured
        defaults are applied based on your selection.
      </p>
    </>
  )
}
