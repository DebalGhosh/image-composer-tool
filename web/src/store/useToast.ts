import { useMemo } from 'react'
import { useStore } from '@/store'
import type { ToastInput } from './types'

// --- useToast hook ------------------------------------------------------
// Thin ergonomic wrapper over pushToast/dismissToast. Callers get typed
// helpers (`toast.danger(...)`) instead of remembering the variant string.
// The returned object is memoized so passing it into effect deps is safe.

export interface ToastHelpers {
  info: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  success: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  warning: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  danger: (message: string, opts?: Omit<ToastInput, 'variant' | 'message'>) => string
  dismiss: (id: string) => void
}

export function useToast(): ToastHelpers {
  const push = useStore((s) => s.pushToast)
  const dismiss = useStore((s) => s.dismissToast)
  return useMemo<ToastHelpers>(
    () => ({
      info: (message, opts) => push({ ...opts, variant: 'info', message }),
      success: (message, opts) => push({ ...opts, variant: 'success', message }),
      warning: (message, opts) => push({ ...opts, variant: 'warning', message }),
      danger: (message, opts) => push({ ...opts, variant: 'danger', message }),
      dismiss,
    }),
    [push, dismiss],
  )
}
