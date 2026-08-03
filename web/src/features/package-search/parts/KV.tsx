export function KV({ k, v, mono }: { k: string; v: string | undefined; mono?: boolean }) {
  if (!v) return null
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: 'var(--muted-color)', minWidth: 100 }}>{k}</span>
      <span
        style={{
          color: 'var(--font-color)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {v}
      </span>
    </div>
  )
}

