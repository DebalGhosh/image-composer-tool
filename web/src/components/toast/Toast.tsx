import { useEffect, useRef, useState } from 'react'
import type { Toast as ToastData, ToastVariant } from '../../store'

interface ToastProps {
  toast: ToastData
  onDismiss: (id: string) => void
}

// Colors + icons per variant. Reads the CSS custom properties defined in
// index.css so the palette follows the current theme.
const VARIANT_STYLES: Record<
  ToastVariant,
  { bg: string; border: string; icon: string; iconColor: string }
> = {
  info: {
    bg: 'var(--toast-info-bg)',
    border: 'var(--classic-blue)',
    icon: 'i',
    iconColor: 'var(--classic-blue)',
  },
  success: {
    bg: 'var(--toast-success-bg)',
    border: 'var(--success)',
    icon: '✓',
    iconColor: 'var(--success)',
  },
  warning: {
    bg: 'var(--toast-warning-bg)',
    border: 'var(--warning)',
    icon: '!',
    iconColor: 'var(--warning)',
  },
  danger: {
    bg: 'var(--toast-danger-bg)',
    border: 'var(--toast-danger-border)',
    icon: '✕',
    iconColor: 'var(--danger)',
  },
}

const DEFAULT_TITLE: Record<ToastVariant, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  danger: 'Error',
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const style = VARIANT_STYLES[toast.variant]
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const dismissedRef = useRef(false)

  // Two-frame trick: mount at translate-x-full/opacity-0, then flip to
  // translate-x-0/opacity-100 so the CSS transition actually animates.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const beginDismiss = () => {
    if (dismissedRef.current) return
    dismissedRef.current = true
    setLeaving(true)
    // Match the CSS transition duration below.
    window.setTimeout(() => onDismiss(toast.id), 200)
  }

  // Auto-dismiss after `duration` ms (unless duration <= 0 = sticky).
  useEffect(() => {
    if (toast.duration <= 0) return
    const t = window.setTimeout(beginDismiss, toast.duration)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, toast.duration])

  return (
    <div
      role={toast.variant === 'danger' ? 'alert' : 'status'}
      aria-live={toast.variant === 'danger' ? 'assertive' : 'polite'}
      className={
        'pointer-events-auto flex w-full max-w-sm gap-3 rounded-md border-l-4 p-3 shadow-lg ' +
        'transition-all duration-200 ease-out ' +
        (visible && !leaving
          ? 'translate-x-0 opacity-100'
          : 'translate-x-4 opacity-0')
      }
      style={{
        background: style.bg,
        borderLeftColor: style.border,
        boxShadow: 'var(--options-shadow)',
        // Fallback surface tint so dark-mode toasts have a visible chip
        // when the tinted rgba() is very subtle over --page-background.
        backgroundColor: `color-mix(in srgb, ${style.bg} 100%, var(--section-background))`,
        color: 'var(--font-color)',
      }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
        style={{ background: style.iconColor }}
      >
        {style.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold" style={{ color: 'var(--title-text)' }}>
          {toast.title ?? DEFAULT_TITLE[toast.variant]}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
          {toast.message}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={beginDismiss}
        className="shrink-0 self-start rounded p-1 text-[var(--muted-color)] hover:bg-black/5 hover:text-[var(--font-color)] dark:hover:bg-white/10"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
