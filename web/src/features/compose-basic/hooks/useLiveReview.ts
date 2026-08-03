import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { ComposeResponse, Manifest } from '@/api/types'
import type { Selection } from '@/store'

/**
 * Resolves the review summary for a complete cascade: debounced, abortable, and
 * at most one request per settled selection.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 *
 * ⚠️ THE `exhaustive-deps` SUPPRESSION BELOW IS LOAD-BEARING AND PRE-EXISTING.
 * The dep array lists the six cascade FIELDS individually rather than the
 * `selection` object, so a store write that produces a new object identity with
 * identical field values does not re-fire the request. Replacing the six with
 * `selection` would issue a fresh compose on every unrelated store update.
 * Do not "fix" it.
 *
 * `selectionRef` is read at request-fire time rather than captured in the
 * closure, so a rapid cascade edit resolves the NEWEST tuple rather than the one
 * that happened to schedule the timer.
 */
export function useLiveReview({
  complete,
  manifest,
  selection,
}: {
  complete: boolean
  manifest: Manifest | null
  selection: Selection
}) {
  const [review, setReview] = useState<ComposeResponse | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  // Latest selection, read at request-fire time inside the debounced effect
  // rather than captured in its closure.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  /*
   * Live review resolution.
   *
   * The review summary now lives in the right pane, which slides open on
   * its own the moment the cascade completes — there is no longer a
   * checkbox to (re-)trigger a fetch. So this resolves on EVERY complete
   * selection rather than latching once: debounced + abortable, mirroring
   * LiveYamlPreview.tsx:43-99 so the two panes stay in step and issue at
   * most one request each per settled selection.
   *
   * Placed BEFORE the loading early-return so hook order stays
   * unconditional across renders (Rules of Hooks).
   *
   * Errors render inline in the pane instead of raising a toast. Same
   * reasoning LiveYamlPreview documents at :76-81 — compose can fail on
   * any intermediate cascade state, and a toast per keystroke is noise.
   * The toast stays reserved for the dispatch path below.
   */
  useEffect(() => {
    if (!complete || !manifest) {
      setReview(null)
      setReviewError(null)
      setReviewLoading(false)
      return
    }

    // Flip the spinner on immediately rather than inside the timeout, so the
    // pane reads "Resolving…" for the debounce window instead of sitting
    // blank (setSel has just cleared the previous summary).
    setReviewLoading(true)
    setReviewError(null)

    // Declared out here so the cleanup below can abort a request this run
    // started. React always runs the previous effect's cleanup before the
    // next effect body, so that covers supersession AND unmount — no
    // separate module/ref bookkeeping needed.
    let ac: AbortController | null = null

    const t = setTimeout(async () => {
      ac = new AbortController()
      const signal = ac.signal
      try {
        // Read the selection at request-fire time rather than from this
        // closure, so a rapid cascade edit resolves the newest tuple.
        const r = await api.compose(selectionRef.current)
        if (signal.aborted) return
        setReview(r)
      } catch (e) {
        if (signal.aborted) return
        setReview(null)
        setReviewError((e as Error).message)
      } finally {
        // Left true when aborted: a newer run owns the flag and is already
        // resolving, so clearing it here would blink the spinner off.
        if (!signal.aborted) setReviewLoading(false)
      }
    }, 200) // Same 200ms beat as LiveYamlPreview.

    return () => {
      clearTimeout(t)
      ac?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    complete,
    manifest,
    selection.vertical,
    selection.sku,
    selection.platform,
    selection.os,
    selection.kernel,
    selection.imageType,
  ])

  // An incomplete cascade has no YAML to show, so never leave the drawer
  // stranded over an empty preview if the user edits a field via keyboard

  /**
   * Clears the summary synchronously. The caller invokes this from its field
   * setter so the pane blanks the INSTANT the user edits, rather than showing a
   * stale summary for the whole debounce window.
   */
  const clearReview = () => {
    setReview(null)
    setReviewError(null)
  }

  return { review, reviewLoading, reviewError, clearReview }
}
