import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useToast } from '@/store'
import type { ComposeRequest, ComposeResponse } from '@/api/types'

/**
 * Resolves the selection to template YAML: debounced, abortable, and dropping
 * stale responses.
 *
 * THREE GUARDS AGAINST THE SAME CLASS OF BUG — a slow response for an old
 * selection overwriting a fast one for the current selection:
 *   1. the 200ms debounce coalesces rapid cascade edits into one request;
 *   2. `inflightRef.abort()` cancels the previous fetch before starting a new one;
 *   3. every `set*` is behind `if (ac.signal.aborted) return`.
 *
 * `beat` increments on each successful swap and is used by the caller as a
 * wrapper `key`, so React remounts the transition div and replays its CSS
 * animation. CodeMirror inside is memoised on `theme` and does NOT remount.
 *
 * ⚠️ THE `exhaustive-deps` SUPPRESSION IS LOAD-BEARING AND PRE-EXISTING. The dep
 * array lists the six cascade FIELDS rather than the `selection` object, so a
 * store write producing a new object identity with identical values does not
 * re-fire the compose. Do not "fix" it.
 *
 * ⚠️ COMPOSE ERRORS DO NOT RAISE A TOAST, deliberately: they fire on every
 * intermediate cascade state, so a toast per keystroke would be noise. The inline
 * banner is enough. `toast` stays wired for a future explicit fire — that is what
 * the `void toast` is for, and removing it would drop the hook.
 *
 * Extracted verbatim from LiveYamlPreview in FE-7c.
 */
export function useComposedYaml({
  selection,
  complete,
}: {
  /**
   * ComposeRequest, NOT the store's Selection. The two are structurally similar
   * but ComposeRequest's `sku` is optional — some verticals have no SKU
   * dimension. Narrowing this to Selection would reject the caller.
   */
  selection: ComposeRequest
  complete: boolean
}) {
  const toast = useToast()
  const [yaml, setYaml] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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


  return { yaml, loading, error, beat }
}
