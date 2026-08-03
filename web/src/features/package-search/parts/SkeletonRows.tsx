export function SkeletonRows() {
  return (
    <div style={{ padding: '8px 16px' }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 0' }}>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--muted-color) 15%, transparent)',
              animation: 'skeleton-pulse 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.06}s`,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: `${50 + ((i * 7) % 30)}%`,
                height: 12,
                borderRadius: 4,
                background: 'color-mix(in srgb, var(--muted-color) 15%, transparent)',
                animation: 'skeleton-pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.06}s`,
              }}
            />
            <div
              style={{
                width: `${30 + ((i * 11) % 40)}%`,
                height: 10,
                marginTop: 4,
                borderRadius: 4,
                background: 'color-mix(in srgb, var(--muted-color) 10%, transparent)',
                animation: 'skeleton-pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.06}s`,
              }}
            />
          </div>
        </div>
      ))}
      <style>{`
        @keyframes skeleton-pulse {
          0%, 100% { opacity: 0.6; }
          50%      { opacity: 1;   }
        }
      `}</style>
    </div>
  )
}

