export function KbdChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 4,
        border: '1px solid var(--border-color)',
        background: 'var(--input-background)',
        color: 'var(--font-color)',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        minWidth: 18,
        justifyContent: 'center',
        lineHeight: 1.4,
      }}
    >
      {children}
    </kbd>
  )
}

// =====================================================================
// Main component
// =====================================================================

