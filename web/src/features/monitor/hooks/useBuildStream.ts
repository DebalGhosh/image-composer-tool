import { useEffect, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { openBuildStream } from '@/api/sse'
import { useToast } from '@/store'
import type { Artifact, BuildDetails } from '@/api/types'
import type { BuildStatus } from '@/types/build'

/** BuildView's own lifecycle, which is NOT the app-wide BuildStatus: it has no
 *  'idle' (the view is not rendered before a build exists) and it adds
 *  'cancelling', a transient state that lives only while Jenkins acknowledges a
 *  stop. Deliberately separate — see types/build.ts. */
export type Status = 'running' | 'cancelling' | 'cancelled' | 'success' | 'failed'

export interface BuildStreamParams {
  buildId: string
  onStatusChange: (s: BuildStatus) => void
  onJenkinsMetaReady?: (
    worker: string,
    buildNo: number,
    buildUrl: string | null,
  ) => void
}

/**
 * Everything that happens for one build: the SSE log stream, the 5s details
 * poll, the one-shot Jenkins-metadata latch, and 404 -> unavailable.
 *
 * FOUR CONCERNS IN ONE EFFECT, DELIBERATELY. They are not separable without
 * changing behaviour, because they share three pieces of mutable local state
 * that must be torn down together:
 *
 *   - `stopPolling` — flipped by cleanup so a fetch already in flight discards
 *     its result instead of writing another build's data into this view.
 *   - `notifiedMeta` — the one-shot latch. Splitting the poll into its own effect
 *     would give it a separate latch, and the parent's history row would be
 *     notified more than once per mount.
 *   - `es` — hoisted so the poll's 404 branch can close the SSE stream when the
 *     build has vanished server-side, without a forward reference.
 *
 * ⚠️ THE DEP ARRAY IS `[buildId]` ONLY, AND THE SUPPRESSION IS LOAD-BEARING.
 * Adding the callbacks would restart the stream and the poll on every parent
 * render that happens to pass a fresh function identity — reconnecting the
 * EventSource and replaying the log from scratch. The comment at the bottom is
 * the original's and stays verbatim.
 */

/**
 * True once Jenkins has de-queued the build and both deep-link fields are
 * populated.
 *
 * Jenkins queue-item resolution is asynchronous, so the first few polls return
 * `worker: ''` and `buildNumber: 0`. The `> 0` test is what stops the parent
 * being handed a build number of zero — which would produce a history row
 * linking at job #0.
 */
function jenkinsMetaReady(d: BuildDetails): boolean {
  return Boolean(
    d.jenkins?.worker && d.jenkins.buildNumber && d.jenkins.buildNumber > 0,
  )
}

/** Fire the one-shot metadata callback. Caller owns the latch. */
function notifyJenkinsMeta(
  d: BuildDetails,
  cb: BuildStreamParams['onJenkinsMetaReady'],
): void {
  if (!cb || !d.jenkins) return
  cb(d.jenkins.worker, d.jenkins.buildNumber, d.jenkins.buildUrl ?? null)
}

/** Everything the SSE listeners need to write into. Grouped rather than passed
 *  positionally — eleven parameters would be unreadable and AGENTS.md caps at
 *  4-5 before a config struct. */
interface StreamSinks {
  buildId: string
  setLogs: React.Dispatch<React.SetStateAction<string[]>>
  setStatus: React.Dispatch<React.SetStateAction<Status>>
  setArtifacts: (a: Artifact[]) => void
  setPhase: (p: string) => void
  setInstall: (i: { done: number; total: number }) => void
  setUnavailable: (u: boolean) => void
  onStatusChange: (s: BuildStatus) => void
  toast: ReturnType<typeof useToast>
}

/**
 * Attach the SSE listeners and return the stream so the caller can close it.
 *
 * Split out of the effect to bring it under the line ceiling. It stays a plain
 * function rather than a hook because it must run INSIDE the effect — the
 * listener set has to be torn down with the same cleanup that stops the poll.
 *
 * The `opened` flag distinguishes the two ways an `error` event arrives: a 404
 * on a build the server has forgotten fires error with readyState CLOSED and no
 * prior open, whereas a mid-stream transport hiccup fires the same event AFTER
 * an open. Only the first means "gone".
 */
function attachBuildStream(s: StreamSinks): EventSource {
  const {
    buildId,
    setLogs,
    setStatus,
    setArtifacts,
    setPhase,
    setInstall,
    setUnavailable,
    onStatusChange,
    toast,
  } = s

  const stream = openBuildStream(buildId)
  // Track whether the SSE ever successfully connected. The initial 404
  // path (build not on server) fires an `error` event with readyState=
  // CLOSED and no prior open, whereas a mid-stream transport hiccup on
  // an already-running build hits the same handler AFTER an open. We
  // use this flag to route the two cases differently.
  let opened = false
  stream.addEventListener('open', () => {
    opened = true
  })
  stream.addEventListener('log', (e) => {
    const { message } = JSON.parse((e as MessageEvent).data)
    setLogs((prev) => [...prev, message])
  })
  // Phase transitions come as a separate event so we don't have to
  // re-derive them client-side from log substrings. The server throttles
  // these to genuine phase changes + install-counter advances; see
  // internal/api/sse.go and phases.go.
  stream.addEventListener('phase', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    if (typeof data.phase === 'string' && data.phase !== '') {
      setPhase(data.phase)
    }
    if (typeof data.installDone === 'number' && typeof data.installTotal === 'number') {
      setInstall({ done: data.installDone, total: data.installTotal })
    }
  })
  stream.addEventListener('complete', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    const s = data.status === 'cancelled' ? 'cancelled' : 'success'
    setStatus(s)
    setArtifacts(data.artifacts ?? [])
    onStatusChange(s === 'success' ? 'success' : 'idle')
    stream.close()
  })
  // NAMED 'error' events carry a JSON payload from the server -- those are
  // terminal (build failed / cancelled) and we should close the stream.
  // The DEFAULT EventSource error event, dispatched on transport-layer
  // hiccups (idle-timeout on a proxy, brief TCP reset, browser buffer flush),
  // has NO `data` field and the browser will auto-reconnect on its own if
  // we leave the EventSource open. Closing on those was killing the stream
  // after the first minor hiccup.
  stream.addEventListener('error', (e) => {
    const raw = (e as MessageEvent).data
    if (!raw) {
      // Native transport error. readyState === CLOSED means the server
      // sent a real closure or the initial connect failed.
      if (stream.readyState === EventSource.CLOSED) {
        if (!opened) {
          // Never got past the initial handshake — server has no
          // record of this build (typically 404 from
          // handleBuildLogs after a backend restart or a build
          // dispatched from a different browser profile). Route to
          // the "unavailable" empty state so the pane stops
          // pretending the build is running or failed.
          setUnavailable(true)
        } else {
          setStatus((prev) => (prev === 'running' ? 'failed' : prev))
          onStatusChange('failed')
        }
      }
      // readyState === CONNECTING → browser is auto-reconnecting; leave alone.
      return
    }
    // Server-sent terminal error (our 'error' event has a JSON payload).
    try {
      const data = JSON.parse(raw)
      const s = data.status === 'cancelled' ? 'cancelled' : 'failed'
      setStatus(s)
      if (s === 'failed' && data.message) {
        toast.danger(String(data.message), { title: 'Build failed', duration: 0 })
      }
      onStatusChange(s)
    } catch {
      setStatus('failed')
      onStatusChange('failed')
    }
    stream.close()
  })

  return stream
}

export function useBuildStream({
  buildId,
  onStatusChange,
  onJenkinsMetaReady,
}: BuildStreamParams) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('running')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [details, setDetails] = useState<BuildDetails | null>(null)
  // Set when the server has no record of this buildId — typically because the
  // local history row survived a backend restart (localStorage outlives the
  // in-memory tracker) or was dispatched from a different profile. Distinct
  // from `failed`: the build didn't fail, we just can't fetch its state any
  // more. Set from either a 404 on the details GET or a `CLOSED` transport
  // error on the SSE stream during the initial connect.
  const [unavailable, setUnavailable] = useState(false)
  // Server-derived phase for the stepper. The server's detectPhase() opens on
  // "dispatching" before any log line has fired, so we match that default here
  // to avoid a first-render flash of the wrong step.
  const [phase, setPhase] = useState<string>('dispatching')
  const [install, setInstall] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  })
  const toast = useToast()

  useEffect(() => {
    setLogs([])
    setStatus('running')
    setArtifacts([])
    setDetails(null)
    setPhase('dispatching')
    setInstall({ done: 0, total: 0 })
    setUnavailable(false)

    // Fetch build details on mount, then poll every 5 s until we've seen
    // both a Jenkins buildNumber AND the Artifactory URL. The URL only
    // surfaces after the PUBLISH stage echoes it -- polling avoids adding
    // another event type to the SSE contract just for this one field.
    // The interval is cheap (a JSON GET against localhost) and stops as
    // soon as the URL lands or the SSE stream reports a terminal state.
    let stopPolling = false
    // Jenkins queue-item resolution happens asynchronously — the first few
    // polls may return worker='' buildNumber=0. Fire the ready callback
    // EXACTLY ONCE per mount when both become populated, so the URL
    // acquires the deep-link fields the moment they're known.
    let notifiedMeta = false
    // Hoisted so the pollDetails 404 branch can close the SSE stream when
    // it lands, without a forward reference.
    let es: EventSource | null = null
    const pollDetails = async () => {
      try {
        const d = await api.buildDetails(buildId)
        // Cleanup may have flipped stopPolling while the fetch was
        // in flight — if the parent unmounted / remounted us for a
        // different buildId, dropping d prevents cross-build state
        // contamination.
        if (stopPolling) return
        setDetails(d)
        if (!notifiedMeta && jenkinsMetaReady(d)) {
          notifiedMeta = true
          notifyJenkinsMeta(d, onJenkinsMetaReady)
        }
        if (d.jenkins?.artifactoryUrl) return // done; stop scheduling
      } catch (e) {
        // 404 means the tracker has no record of this build — usually the
        // server was restarted since the row was written to localStorage.
        // Don't keep polling; the pane switches to the "unavailable"
        // empty state so the user isn't left staring at a spinning
        // terminal + a misleading "Running" pill.
        if (e instanceof ApiError && e.status === 404) {
          if (!stopPolling) {
            setUnavailable(true)
            es?.close()
          }
          return
        }
        /* other errors are transient — keep polling */
      }
      if (!stopPolling) setTimeout(pollDetails, 5000)
    }
    pollDetails()

    es = attachBuildStream({
      buildId,
      setLogs,
      setStatus,
      setArtifacts,
      setPhase,
      setInstall,
      setUnavailable,
      onStatusChange,
      toast,
    })

    return () => {
      stopPolling = true
      es?.close()
    }
    // Intentionally depend only on buildId: the SSE stream + poll should
    // restart when the build we're viewing changes, not when the parent
    // happens to pass a fresh callback identity. onJenkinsMetaReady is
    // wrapped in useCallback([]) upstream so its identity is stable
    // anyway, but this keeps the effect's contract clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId])

  return {
    logs,
    status,
    setStatus,
    artifacts,
    details,
    unavailable,
    phase,
    install,
  }
}
