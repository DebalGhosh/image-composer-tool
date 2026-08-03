import type { YamlValidity } from '../model/validateYaml'

/**
 * The status line under the editor: byte count, line count, and validity.
 *
 * Reads as three independent facts rather than one verdict, deliberately — an
 * operator debugging a rejected template wants to know WHICH limit they hit.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function YamlMetaRow({
  yaml,
  byteLen,
  validity,
  empty,
  tooLarge,
}: {
  yaml: string
  byteLen: number
  validity: YamlValidity
  empty: boolean
  tooLarge: boolean
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--muted-color)' }}>
      <span>
        {yaml.length} chars · {(byteLen / 1024).toFixed(1)} KB
      </span>
      {/* Compact live-validity pill. Reads YAMLParseError line/col from `yaml`. */}
      {!empty && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: validity.ok
              ? 'color-mix(in srgb, var(--success) 12%, transparent)'
              : 'color-mix(in srgb, var(--danger) 14%, transparent)',
            color: validity.ok ? 'var(--success)' : 'var(--danger-fg)',
          }}
          aria-live="polite"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: validity.ok ? 'var(--success)' : 'var(--danger-fg)' }}
          />
          {validity.ok
            ? 'YAML valid'
            : validity.line
              ? `YAML invalid · line ${validity.line}${validity.col ? `, col ${validity.col}` : ''}`
              : 'YAML invalid'}
        </span>
      )}
      {tooLarge && (
        <span style={{ color: 'var(--danger-fg)' }}>
          Exceeds 200 KB hard limit — trim before building.
        </span>
      )}
    </div>

  )
}
