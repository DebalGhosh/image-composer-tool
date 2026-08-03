// NOTE (FE-2): this is the one primitive that reaches into the store. It is a
// connected container rather than a pure primitive — it subscribes to `toasts`
// so any component can push one without threading context through the tree,
// which is the design (see the toast-slice comment in store.ts).
//
// The types it consumes (Toast, ToastVariant) are generic UI vocabulary, not
// domain concepts, so this does not violate the components/-holds-no-domain-
// knowledge rule. Left as-is deliberately; FE-7 splits the store by slice and is
// the right moment to decide whether the subscription moves to app/.
import { useStore } from '@/store'
import { Toast } from '@/components/feedback/toast/Toast'

// Renders the active toast stack in the top-right corner. Fixed positioning
// so scrolling BuildImagePage logs doesn't drag the toasts off-screen.
export function ToastContainer() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div
      // pointer-events-none on the wrapper so the invisible column doesn't
      // intercept clicks on the page underneath; the Toast card re-enables
      // pointer events on itself.
      className="pointer-events-none fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}
