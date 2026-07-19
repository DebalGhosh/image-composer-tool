import { useEffect, useRef, useState } from 'react'
import { useStore, useToast } from '../store'
import { api } from '../api/client'
import type { ComposeRequest, ComposeResponse } from '../api/types'
import { YamlEditor } from './YamlEditor'

interface LiveYamlPreviewProps {
  /** Selection fields; the preview resolves whenever a complete tuple is picked. */
  selection: ComposeRequest
  /** True when all cascading fields are filled and a compose call is meaningful. */
  complete: boolean
}

/**
 * Read-only, live-updating YAML preview.
 *
 * Watches the Basic-tab selection and calls POST /api/v1/templates/compose
 * whenever the selection is complete. Debounces to avoid flooding the backend
 * during rapid cascade changes. Fades the editor while a new compose is in
 * flight so the transition to fresh YAML feels intentional.
 *
 * When the selection is incomplete, shows a friendly stub instead of the last
 * successful YAML — surfacing "you have unfinished work" over "here's stale
 * data" (matching the Basic tab's Review checkbox which also invalidates).
 */
export function LiveYamlPreview({ selection, complete }: LiveYamlPreviewProps) {
  const theme = useStore((s) => s.theme)
  const toast = useToast()
  const [yaml, setYaml] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Bumped on every successful yaml swap. Used as the wrapper `key` so React
   * remounts the transition div, replaying the CSS animation. CodeMirror inside
   * is memoised on `theme` so it does NOT remount — cursor/scroll stays put.
   * (Well — read-only, so no cursor to save, but same principle.)
   */
  const [beat, setBeat] = useState(0)
  const stateRef = useRef({ selection, complete })
  stateRef.current = { selection, complete }
  const inflightRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!complete) {
      // Selection became incomplete — cancel any in-flight compose and clear.
      inflightRef.current?.abort()
      inflightRef.current = null
      setLoading(false)
      setYaml('')
      setError(null)
      return
    }

    // Debounce a beat so rapid cascade edits collapse to one request.
    const t = setTimeout(async () => {
      // Cancel a stale in-flight fetch before starting a fresh one, so a slow
      // response for a stale selection can't clobber a fast one for the current
      // selection.
      inflightRef.current?.abort()
      const ac = new AbortController()
      inflightRef.current = ac

      setLoading(true)
      setError(null)
      try {
        // Snapshot the selection at request-fire time so we can drop the result
        // if the user has already moved on.
        const capturedSelection = stateRef.current.selection
        const resp: ComposeResponse = await api.compose(capturedSelection)
        if (ac.signal.aborted) return
        setYaml(resp.yaml)
        setBeat((n) => n + 1)
      } catch (e) {
        if (ac.signal.aborted) return
        const msg = (e as Error).message
        setError(msg)
        // Do NOT push a toast for compose errors — they fire on every cascade
        // change; a toast per keystroke would be noise. The inline preview
        // banner is enough. Reserve the toast for surprises the user might miss
        // (build failures, manifest load failures).
        void toast // keep the hook wired for future explicit fires
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }, 200) // 200ms debounce — fast enough to feel live, slow enough to coalesce.

    return () => clearTimeout(t)
    // Depend on the JSON shape of the selection so a same-value update doesn't
    // re-fire, but any real field change does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    complete,
    selection.vertical,
    selection.sku,
    selection.platform,
    selection.os,
    selection.kernel,
    selection.imageType,
  ])

  /* ------------------------- render ------------------------- */

  const showStub = !complete
  const showError = complete && error && !loading
  const showYaml = complete && yaml.length > 0

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-color)' }}>
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: showYaml
                ? 'var(--success)'
                : showError
                  ? 'var(--danger)'
                  : 'var(--muted-color)',
              transition: 'background-color 200ms ease',
            }}
          />
          <span>
            {loading
              ? 'Resolving template…'
              : showError
                ? 'Preview unavailable'
                : showYaml
                  ? 'Live preview'
                  : 'Waiting for selection'}
          </span>
        </div>
        {showYaml && (
          <button
            className="rounded border px-2 py-0.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
            style={{ borderColor: 'var(--border-color)', color: 'var(--muted-color)' }}
            onClick={() => navigator.clipboard.writeText(yaml)}
            title="Copy YAML to clipboard"
          >
            Copy
          </button>
        )}
      </div>

      <div
        className="preview-transition min-h-0 flex-1 overflow-hidden rounded-md border"
        style={{
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
          opacity: loading ? 0.55 : 1,
          transition: 'opacity 180ms ease',
        }}
        // Force a keyed remount on every successful yaml swap so the fade-in
        // keyframe replays. YamlEditor itself is inside so CodeMirror mounts
        // fresh — read-only, so no state to preserve.
        key={`beat-${beat}`}
      >
        {showStub && (
          <StubPanel />
        )}
        {showError && (
          <ErrorPanel message={error!} />
        )}
        {showYaml && (
          <YamlEditor
            value={yaml}
            onChange={() => {}}
            readOnly
            height="100%"
            className="h-full"
          />
        )}
      </div>

      {/* Local keyframe: subtle fade + upward slide as fresh YAML lands. */}
      <style>{`
        .preview-transition > * {
          animation: yaml-swap 320ms cubic-bezier(0.22, 0.7, 0.32, 1);
        }
        @keyframes yaml-swap {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* Suppress `theme` unused warning while keeping the dep so future
          themed-viewer tweaks can pull it in easily. */}
      <div hidden data-theme={theme} />
    </div>
  )
}

function StubPanel() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div style={{ color: 'var(--muted-color)' }}>
        <p className="text-sm">
          Complete the cascading fields on the left to see the resolved
          template YAML here.
        </p>
        <p className="mt-1 text-xs opacity-70">
          The preview refreshes every time you change a field.
        </p>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="grid h-full place-items-center p-6 text-center"
      style={{ color: 'var(--danger-fg)' }}
    >
      <div>
        <p className="text-sm font-semibold">Preview unavailable</p>
        <p className="mt-1 font-mono text-xs opacity-80">{message}</p>
      </div>
    </div>
  )
}
