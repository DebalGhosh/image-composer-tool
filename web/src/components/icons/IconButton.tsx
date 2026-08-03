import type { ReactNode } from 'react'

export function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: 'var(--input-background)',
        borderColor: 'var(--border-color)',
        color: danger ? 'var(--danger, #b91c1c)' : 'var(--font-color)',
      }}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------------- *
 * Utilities
 * ------------------------------------------------------------------------- */

