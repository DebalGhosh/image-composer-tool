export function IdleState({
  indexMissing,
  recents,
  onPick,
}: {
  indexMissing: boolean
  recents: string[]
  onPick: (q: string) => void
}) {
  if (indexMissing) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 8, fontWeight: 600 }}>
          The package index isn't available.
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted-color)' }}>
          Type a package name and use <em>+ Add "…"</em> to include it verbatim.
        </div>
      </div>
    )
  }
  if (recents.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted-color)' }}>
          Start typing to search 139,000+ packages.
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted-color)', marginTop: 6 }}>
          Try <em>openvino</em>, <em>machine learning</em>, or <em>nginx</em>.
        </div>
      </div>
    )
  }
  return (
    <div style={{ padding: '16px 20px' }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--muted-color)',
          marginBottom: 8,
        }}
      >
        Recent searches
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {recents.slice(0, 5).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onPick(r)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 4,
              border: '1px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--font-color)',
              textAlign: 'left',
              fontSize: 13,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background =
                'color-mix(in srgb, var(--classic-blue) 8%, transparent)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ color: 'var(--muted-color)' }}>
              <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>{r}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

