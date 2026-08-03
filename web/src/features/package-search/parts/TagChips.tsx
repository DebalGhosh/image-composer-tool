export function TagChips({
  items,
  tone,
  mono,
}: {
  items: string[]
  tone: 'strong' | 'normal' | 'muted'
  mono?: boolean
}) {
  if (items.length === 0) return null
  const bg =
    tone === 'strong'
      ? 'color-mix(in srgb, var(--classic-blue) 12%, transparent)'
      : tone === 'normal'
        ? 'color-mix(in srgb, var(--muted-color) 10%, transparent)'
        : 'transparent'
  const border =
    tone === 'strong' ? 'color-mix(in srgb, var(--classic-blue) 30%, var(--border-color))' : 'var(--border-color)'
  const color = tone === 'strong' ? 'var(--classic-blue)' : 'var(--font-color)'
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.slice(0, 24).map((t) => (
        <span
          key={t}
          style={{
            display: 'inline-block',
            padding: '2px 6px',
            fontSize: 10,
            fontFamily: mono ? 'var(--font-mono)' : undefined,
            borderRadius: 4,
            background: bg,
            border: '1px solid ' + border,
            color,
          }}
        >
          {t}
        </span>
      ))}
      {items.length > 24 && (
        <span style={{ fontSize: 10, color: 'var(--muted-color)', padding: '2px 4px' }}>
          +{items.length - 24}
        </span>
      )}
    </div>
  )
}

