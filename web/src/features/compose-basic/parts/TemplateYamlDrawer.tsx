import { DialogOverlay } from '@/components/layout/DialogOverlay'
import { LiveYamlPreview } from '../LiveYamlPreview'
import type { Selection } from '@/store'

/**
 * The read-only template-YAML drawer.
 *
 * LiveYamlPreview is handed through untouched — it is self-fetching (200ms
 * debounce + AbortController) and needs only these two props. The drawer traps
 * focus, so the selection cannot change while it is open and the preview
 * resolves exactly once per open.
 *
 * ⚠️ TWO LOAD-BEARING DETAILS, BOTH ABOUT THE FULLSCREEN OVERLAY INSIDE:
 *
 * 1. `closeOnEscape={!yamlFullscreen}` defers to the YamlEditor. Both it and
 *    DialogOverlay install document-level CAPTURE-phase Escape handlers that
 *    stopPropagation, and DialogOverlay's is registered first (on mount, versus
 *    on entering fullscreen). Without this prop, Escape while fullscreen would
 *    tear down the whole drawer instead of merely leaving fullscreen.
 *
 * 2. The drawer slides via `right`, NEVER `transform`. A permanent transform
 *    establishes a containing block for fixed-position descendants, which would
 *    trap the editor's fullscreen overlay inside this 720px panel. Same reason
 *    the review pane avoids one; see DialogOverlay's header and
 *    .claude/UI-LAYOUT.md.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function TemplateYamlDrawer({
  open,
  onClose,
  closeOnEscape,
  selection,
  complete,
}: {
  open: boolean
  onClose: () => void
  /** False while the editor inside owns fullscreen — see note 1 above. */
  closeOnEscape: boolean
  selection: Selection
  complete: boolean
}) {
  return (
    <DialogOverlay
      open={open}
      onClose={onClose}
      variant="drawer-right"
      closeOnEscape={closeOnEscape}
      title="Template Preview"
      ariaLabelledBy="basic-yaml-drawer-title"
    >
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <p className="mb-3 text-xs" style={{ color: 'var(--muted-color)' }}>
          Read-only. Resolved from the selection on the left.
        </p>
        <div className="min-h-0 flex-1">
          <LiveYamlPreview selection={selection} complete={complete} />
        </div>
      </div>
    </DialogOverlay>
  )
}
