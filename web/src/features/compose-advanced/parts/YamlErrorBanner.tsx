import type { YamlValidity } from '../model/validateYaml'

/**
 * The inline syntax-error banner, with the parser's line and column.
 *
 * Inline rather than a toast: the buffer re-parses on every keystroke, so a toast
 * per character would be unusable. Same reasoning the Basic tab applies to its
 * compose errors.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function YamlErrorBanner({
  invalid,
  validity,
}: {
  invalid: boolean
  validity: YamlValidity
}) {
  return (
    <>
      {invalid && validity.message && (
        <div
          className="mt-3 rounded-md border-l-4 p-3 text-xs"
          style={{
            background: 'color-mix(in srgb, var(--danger) 8%, var(--section-background))',
            borderLeftColor: 'var(--danger)',
            color: 'var(--font-color)',
          }}
        >
          <p className="mb-1 font-semibold" style={{ color: 'var(--danger-fg)' }}>
            YAML syntax error
            {validity.line ? ` at line ${validity.line}${validity.col ? `, col ${validity.col}` : ''}` : ''}
          </p>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed opacity-90">
            {validity.message}
          </pre>
        </div>
      )}
    </>
  )
}
