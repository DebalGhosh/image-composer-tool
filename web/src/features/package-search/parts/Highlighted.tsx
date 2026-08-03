import { highlightSegments } from '../model/format'

/**
 * Renders `text` with every case-insensitive occurrence of the query tokens
 * wrapped in a <mark>.
 *
 * The SPLITTING lives in model/format.highlightSegments (pure, tested); this is
 * only the rendering half. The parity contract comes from there: even indices
 * are plain text, odd indices are matches.
 *
 * When there is nothing to highlight, the raw string is returned rather than a
 * fragment of per-character spans.
 */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const parts = highlightSegments(text, query)
  if (!parts) return <>{text}</>
  return (
    <>
      {parts.map((p, i) =>
        // odd indices are captures — highlight them.
        i % 2 === 1 ? (
          <mark
            key={i}
            style={{
              background: 'color-mix(in srgb, var(--classic-blue) 25%, transparent)',
              color: 'inherit',
              padding: '0 1px',
              borderRadius: 2,
            }}
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}
