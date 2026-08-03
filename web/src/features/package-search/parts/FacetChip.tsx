export function FacetChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid ' + (active ? 'var(--classic-blue)' : 'var(--border-color)'),
        background: active
          ? 'color-mix(in srgb, var(--classic-blue) 15%, var(--section-background))'
          : 'var(--input-background)',
        color: active ? 'var(--classic-blue)' : 'var(--font-color)',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      {label}
      <span style={{ color: 'var(--muted-color)', fontWeight: 400 }}>· {count}</span>
    </button>
  )
}

