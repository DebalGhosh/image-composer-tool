export function EmptyState({
  query,
  onAddManually,
}: {
  query: string
  onAddManually?: () => void
}) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: 'var(--font-color)', marginBottom: 8 }}>
        No packages match <strong style={{ fontFamily: 'var(--font-mono)' }}>{query}</strong>.
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted-color)', marginBottom: 16 }}>
        Try a shorter query, or add the package by exact name.
      </div>
      {onAddManually && (
        <button
          type="button"
          onClick={onAddManually}
          style={{
            appearance: 'none',
            padding: '6px 14px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--classic-blue)',
            background: 'transparent',
            color: 'var(--classic-blue)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >
          + Add "{query}" manually
        </button>
      )}
    </div>
  )
}

