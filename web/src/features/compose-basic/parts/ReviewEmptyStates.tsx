/**
 * What the review surface shows before a summary exists.
 *
 * Two mutually exclusive states. THE PARENT GATES ON `!review`, so neither test
 * is repeated here — the original re-tested `!review &&` inside each branch,
 * which was redundant even before the split and would now imply that `review` is
 * in scope. Behaviour is unchanged.
 *
 *   - resolving: the spinner text, shown for the whole 200ms debounce window so
 *     the pane never sits blank after an edit clears the previous summary;
 *   - error: rendered INLINE rather than raised as a toast. Compose can fail on
 *     any intermediate cascade state, so a toast per keystroke would be noise —
 *     the toast is reserved for the dispatch path. Same reasoning
 *     LiveYamlPreview documents for its own error handling.
 *
 * Extracted from BasicPage via ReviewPane in FE-7c.
 */
export function ReviewEmptyStates({
  reviewLoading,
  reviewError,
}: {
  reviewLoading: boolean
  reviewError: string | null
}) {
  return (
    <>
      {reviewLoading && (
        <p className="text-xs" style={{ color: 'var(--muted-color)' }}>
          Resolving configuration…
        </p>
      )}
      {reviewError && (
        <div
          className="rounded-md border p-3 text-xs"
          style={{
            borderColor:
              'color-mix(in srgb, var(--danger) 45%, var(--border-color))',
            background:
              'color-mix(in srgb, var(--danger) 6%, var(--section-background))',
          }}
        >
          <p className="font-semibold" style={{ color: 'var(--danger)' }}>
            Review unavailable
          </p>
          <p
            className="mt-1 font-mono break-words"
            style={{ color: 'var(--muted-color)' }}
          >
            {reviewError}
          </p>
        </div>
      )}
    </>
  )
}
