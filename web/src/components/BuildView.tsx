import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useToast } from '../store'
import type { Artifact, BuildDetails } from '../api/types'
import { BuildProgress } from './BuildProgress'
import { Card } from './Card'
import { SummaryPanel } from './SummaryPanel'
import { TerminalLog } from './TerminalLog'

type BuildStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

interface BuildViewProps {
  buildId: string
  onRetry: () => Promise<void>
  retrying: boolean
  onStatusChange: (s: BuildStatus) => void
  /**
   * Optional — called ONCE per mount when the polling details fetch
   * first returns non-empty jenkins.worker AND jenkins.buildNumber.
   * The parent updates the corresponding history entry. Fires at most
   * once per BuildView lifetime; ignored if the parent didn't pass it.
   * The third argument is the specific build URL (null if unavailable);
   * lets the history-list row link directly at the build, not just the
   * job.
   */
  onJenkinsMetaReady?: (
    worker: string,
    buildNo: number,
    buildUrl: string | null,
  ) => void
}

// Full MVP-1 build lifecycle. "not-started" is represented by not rendering this
// component at all; once a build exists it moves through the states below.
type Status = 'running' | 'cancelling' | 'cancelled' | 'success' | 'failed'

export function BuildView({
  buildId,
  onRetry,
  retrying,
  onStatusChange,
  onJenkinsMetaReady,
}: BuildViewProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('running')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [details, setDetails] = useState<BuildDetails | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // `unavailable` is set when the server has no record of this buildId —
  // typically because the local history row survived a backend restart
  // (localStorage outlives the in-memory tracker) or was dispatched from
  // a different profile. Distinct from `failed`: the build didn't fail,
  // we just can't fetch its state any more. Set from either a 404 on the
  // details GET or a `CLOSED` transport error on the SSE stream during
  // the initial connect.
  const [unavailable, setUnavailable] = useState(false)
  // Server-derived phase for the stepper. Server-side detectPhase() opens on
  // "dispatching" before any log line has fired, so we match that default
  // here to avoid a first-render flash of the wrong step.
  const [phase, setPhase] = useState<string>('dispatching')
  const [install, setInstall] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  })
  const terminalWrapRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  // Track the browser's fullscreen state so the toggle button icon flips
  // correctly even when the user leaves fullscreen via Esc (browsers don't
  // fire a click on our button in that case).
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === terminalWrapRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const el = terminalWrapRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      // Safari uses the webkit-prefixed variant. Fall back if the standard
      // API is missing; catch so we don't crash on unsupported browsers.
      const req = el.requestFullscreen ??
        (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen
      req?.call(el)?.catch(() => {})
    }
  }

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
        if (
          !notifiedMeta &&
          onJenkinsMetaReady &&
          d.jenkins?.worker &&
          d.jenkins.buildNumber &&
          d.jenkins.buildNumber > 0
        ) {
          notifiedMeta = true
          onJenkinsMetaReady(
            d.jenkins.worker,
            d.jenkins.buildNumber,
            d.jenkins.buildUrl ?? null,
          )
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

    const stream = new EventSource(api.logsUrl(buildId))
    es = stream
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

    return () => {
      stopPolling = true
      stream.close()
    }
    // Intentionally depend only on buildId: the SSE stream + poll should
    // restart when the build we're viewing changes, not when the parent
    // happens to pass a fresh callback identity. onJenkinsMetaReady is
    // wrapped in useCallback([]) upstream so its identity is stable
    // anyway, but this keeps the effect's contract clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId])

  const copyLogs = () => navigator.clipboard.writeText(logs.join('\n'))
  const downloadLogs = () => {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `build-${buildId}.log`
    a.click()
    URL.revokeObjectURL(url)
  }
  const copyPath = (path: string) => navigator.clipboard.writeText(path)
  const copyCommand = () => details && navigator.clipboard.writeText(details.command)

  // Server has no record of this build — usually a localStorage row that
  // outlived a backend restart. Render an explicit empty state so the pane
  // doesn't misrepresent the situation as "Failed + Waiting for build
  // output". The row's own status pill (in BuildHistoryList) still shows
  // whatever status was last written to localStorage — no lying, no
  // spurious failures.
  if (unavailable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div
          className="flex-none rounded-md border p-6 text-sm"
          style={{
            borderColor: 'var(--border-color)',
            background: 'var(--section-background)',
            color: 'var(--font-color)',
          }}
        >
          <div className="mb-2 font-semibold">
            Build details are no longer available on the server.
          </div>
          <div style={{ color: 'var(--muted-color)' }}>
            This row is only in local history. The backend was likely
            restarted since the build ran — logs and artifacts for it are
            no longer served. You can still delete it from the list or
            open the Jenkins link if one was captured.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/*
       * Compact status strip. What used to live in a dedicated Build
       * Status card now spreads across two places:
       *   - the corresponding history row (worker chip, status pill,
       *     Jenkins link) in BuildHistoryList
       *   - this inline strip which surfaces the Retry affordance
       *     when the terminal state is failed/cancelled. Kept here
       *     because retry needs `lastYamlRef`, which is scoped to
       *     the App-level dispatch state, not the history entry.
       */}
      {/* Phase stepper — shows where the build currently is. Stays visible
          through the terminal state: on failure/cancel the step where things
          stopped flashes red, so the user can see at a glance whether the
          break was early (dispatch) or late (publish). Suppressed only on
          `success` because the artifacts card then dominates the view and
          the "all green" stepper would be redundant. */}
      {status !== 'success' && (
        <BuildProgress
          phase={phase}
          install={install}
          failed={status === 'failed' || status === 'cancelled'}
        />
      )}
      {(status === 'failed' || status === 'cancelled') && (
        <div
          className="flex-none rounded-md border p-3 text-xs"
          style={{
            borderColor:
              'color-mix(in srgb, var(--danger) 45%, var(--border-color))',
            background:
              'color-mix(in srgb, var(--danger) 6%, var(--section-background))',
            color: 'var(--font-color)',
          }}
        >
          <div className="flex items-center gap-3">
            <span className="font-semibold">
              {status === 'failed' ? 'Build failed.' : 'Build cancelled.'}
            </span>
            <span style={{ color: 'var(--muted-color)' }}>
              Inspect the log and retry when ready.
            </span>
            <button
              className="ml-auto cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
              style={{
                borderColor: 'var(--border-color)',
                color: 'var(--font-color)',
              }}
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? 'Starting…' : '↺ Retry'}
            </button>
          </div>
        </div>
      )}

      {/* Summary — rendered inline when the build path carries one
          (Basic-tab dispatches). Interactive/Advanced dispatches don't
          set summary; this block collapses cleanly in that case. */}
      {details?.summary && (
        <div className="grid flex-none grid-cols-1 gap-3 xl:grid-cols-2">
          <SummaryPanel
            heading="Selection"
            rows={
              [
                ['Vertical', details.summary.vertical],
                details.summary.sku ? ['SKU', details.summary.sku] : null,
                ['Platform', details.summary.platform],
                ['OS', details.summary.os],
                ['Image Type', details.summary.imageType.toUpperCase()],
              ] as ([string, string] | null)[]
            }
          />
          <SummaryPanel
            heading="Image"
            rows={
              [
                [
                  'Name',
                  details.summary.imageName +
                    (details.summary.imageVersion
                      ? ' (v' + details.summary.imageVersion + ')'
                      : ''),
                ],
                details.summary.description
                  ? ['Description', details.summary.description]
                  : null,
                ['Architecture', details.summary.architecture],
                details.summary.kernelVersion
                  ? ['Kernel', details.summary.kernelVersion]
                  : null,
                ['Packages', details.summary.packageCount + ' packages'],
                details.summary.diskSize
                  ? [
                      'Disk',
                      details.summary.diskSize +
                        (details.summary.partitionTable
                          ? ', ' +
                            details.summary.partitionTable.toUpperCase()
                          : '') +
                        (details.summary.partitionCount
                          ? ', ' +
                            details.summary.partitionCount +
                            ' partitions'
                          : ''),
                    ]
                  : null,
                details.summary.hostname
                  ? ['Hostname', details.summary.hostname]
                  : null,
              ] as ([string, string] | null)[]
            }
          />
        </div>
      )}

      {/*
       * DETAILS — collapsible section for the exact command, template file,
       * and worker / work-dir metadata. Uses the standard accordion Card
       * (same as Interactive tab sections) so the visual language stays
       * consistent. Collapsed by default: the log is what the operator
       * really wants; details are for post-mortem.
       */}
      {details && (
        <Card
          title="Build details"
          titleStyle="section"
          collapsible
          defaultCollapsed
          className="flex-none"
        >
          <div className="space-y-4 text-xs">
            {/* Command — dark code surface matching the terminal + YAML editor. */}
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--muted-color)' }}
                >
                  Command
                </span>
                <button
                  className="cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  style={{
                    borderColor: 'var(--border-color)',
                    color: 'var(--muted-color)',
                  }}
                  onClick={copyCommand}
                  title="Copy command to clipboard"
                >
                  Copy
                </button>
              </div>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-relaxed"
                style={{
                  background: '#1e1e1e',
                  color: '#d4d4d4',
                }}
              >
                {details.command}
              </pre>
            </div>

            {/* Template row */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: 'var(--muted-color)' }}
              >
                Template
              </span>
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--font-color)' }}
              >
                {details.template}
              </span>
              <a
                className="cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                style={{
                  borderColor: 'var(--border-color)',
                  color: 'var(--muted-color)',
                }}
                href={api.templateUrl(buildId)}
                download={details.template}
              >
                Download
              </a>
            </div>

            {/* Jenkins metadata (dispatched path) or local work/cache dirs */}
            {details.jenkins ? (
              <dl
                className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]"
                style={{ color: 'var(--font-color)' }}
              >
                <dt
                  className="font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--muted-color)' }}
                >
                  Worker
                </dt>
                <dd className="break-all font-mono">
                  {details.jenkins.worker}
                </dd>
                {details.jenkins.buildNumber ? (
                  <>
                    <dt
                      className="font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--muted-color)' }}
                    >
                      Build
                    </dt>
                    <dd className="break-all font-mono">
                      <a
                        className="underline"
                        style={{ color: 'var(--classic-blue)' }}
                        href={details.jenkins.buildUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        #{details.jenkins.buildNumber}
                      </a>
                    </dd>
                  </>
                ) : null}
                <dt
                  className="font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--muted-color)' }}
                >
                  Job
                </dt>
                <dd className="break-all">
                  <a
                    className="font-mono underline"
                    style={{ color: 'var(--classic-blue)' }}
                    href={details.jenkins.jobUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {details.jenkins.jobUrl}
                  </a>
                </dd>
              </dl>
            ) : (
              (details.workDir || details.cacheDir) && (
                <dl
                  className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]"
                  style={{ color: 'var(--font-color)' }}
                >
                  {details.workDir && (
                    <>
                      <dt
                        className="font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--muted-color)' }}
                      >
                        Work dir
                      </dt>
                      <dd className="break-all font-mono">
                        {details.workDir}
                      </dd>
                    </>
                  )}
                  {details.cacheDir && (
                    <>
                      <dt
                        className="font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--muted-color)' }}
                      >
                        Cache dir
                      </dt>
                      <dd className="break-all font-mono">
                        {details.cacheDir}
                      </dd>
                    </>
                  )}
                </dl>
              )
            )}
          </div>
        </Card>
      )}

      {/*
       * BUILD LOG — the star of the show. Terminal is always dark (both
       * app themes) to match the YAML editor's vscode-dark background, so
       * the "code surfaces" family reads as one visual layer.
       */}
      <Card
        title="Build log"
        titleStyle="section"
        actions={
          <div className="flex items-center gap-1">
            <IconAction
              onClick={copyLogs}
              disabled={logs.length === 0}
              title="Copy logs to clipboard"
              label="Copy"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </IconAction>
            <IconAction
              onClick={downloadLogs}
              disabled={logs.length === 0}
              title="Download logs as a file"
              label="Download"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </IconAction>
            <IconAction
              onClick={toggleFullscreen}
              title={
                isFullscreen ? 'Exit fullscreen (Esc)' : 'View terminal fullscreen'
              }
              label={isFullscreen ? 'Collapse' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 14h6v6" />
                  <path d="M20 10h-6V4" />
                  <path d="M14 10l7-7" />
                  <path d="M3 21l7-7" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 8V3h5" />
                  <path d="M21 8V3h-5" />
                  <path d="M3 16v5h5" />
                  <path d="M21 16v5h-5" />
                </svg>
              )}
            </IconAction>
          </div>
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* min-h-0 is critical on flex children -- default min-height:auto
            would prevent the terminal from shrinking below its content size,
            breaking the flex-1 grow behavior. When this element is the
            fullscreen target the browser paints its own black backdrop
            outside the terminal; the inline padding and border-radius are
            fine to keep because the terminal container fills the element.
            Terminal surface matches the YAML editor's vscode-dark (#1e1e1e)
            in BOTH app themes so log + code read as the same family. */}
        <div
          ref={terminalWrapRef}
          className="terminal-fullscreen-host min-h-0 flex-1 overflow-hidden rounded-md"
          style={{
            background: '#1e1e1e',
            padding: '8px',
          }}
        >
          {logs.length === 0 ? (
            <div
              className="p-3 font-mono text-xs"
              style={{ color: '#8a8a8a' }}
            >
              Waiting for build output…
            </div>
          ) : (
            <TerminalLog logs={logs} className="h-full" />
          )}
        </div>
      </Card>

      {/*
       * ARTIFACTS — appears only when something to link at. The
       * Artifactory row is highlighted more prominently than the
       * individual file rows because that's the shareable outcome for
       * downstream consumers.
       */}
      {(artifacts.length > 0 || details?.jenkins?.artifactoryUrl) && (
        <Card title="Artifacts" titleStyle="section" className="flex-none">
          {details?.jenkins?.artifactoryUrl && (
            <div
              className="mb-3 flex flex-wrap items-center gap-3 rounded-md border p-3 text-xs"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--classic-blue) 45%, var(--border-color))',
                background:
                  'color-mix(in srgb, var(--classic-blue) 6%, var(--section-background))',
              }}
            >
              <span
                className="font-semibold uppercase tracking-wider"
                style={{ color: 'var(--muted-color)' }}
              >
                Artifactory
              </span>
              <a
                className="flex-1 truncate font-mono text-[11px] underline"
                style={{ color: 'var(--classic-blue)' }}
                href={details.jenkins.artifactoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={details.jenkins.artifactoryUrl}
              >
                {details.jenkins.artifactoryUrl}
              </a>
              <div className="flex items-center gap-1">
                <button
                  className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  style={{
                    borderColor: 'var(--border-color)',
                    color: 'var(--muted-color)',
                  }}
                  title="Copy Artifactory URL to clipboard"
                  onClick={() =>
                    details.jenkins &&
                    copyPath(details.jenkins.artifactoryUrl!)
                  }
                >
                  Copy
                </button>
                <a
                  className="cursor-pointer rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  style={{
                    borderColor: 'var(--classic-blue)',
                    color: 'var(--classic-blue)',
                  }}
                  href={details.jenkins.artifactoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the Artifactory directory in a new tab"
                >
                  Open ↗
                </a>
              </div>
            </div>
          )}

          {artifacts.length > 0 && (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] font-semibold uppercase tracking-wider"
                  style={{
                    background:
                      'color-mix(in srgb, var(--classic-blue) 8%, var(--section-background))',
                    color: 'var(--muted-color)',
                  }}
                >
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Path</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a, i) => {
                  // Prefer a Jenkins-hosted URL when the artifact carries one; fall
                  // back to the local proxy path otherwise. `key` uses name+index
                  // because Jenkins artifacts may repeat filenames across nested
                  // relative paths.
                  const href =
                    a.url ??
                    `/api/v1/builds/${buildId}/artifacts/${encodeURIComponent(a.name)}`
                  const display = a.path ?? a.url ?? a.name
                  return (
                    <tr
                      key={a.name + ':' + i}
                      className="border-b"
                      style={{ borderColor: 'var(--border-color)' }}
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {a.url ? (
                          <a
                            className="underline"
                            style={{ color: 'var(--classic-blue)' }}
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {a.name}
                          </a>
                        ) : (
                          a.name
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-[11px] uppercase tracking-wide"
                        style={{ color: 'var(--muted-color)' }}
                      >
                        {a.type}
                      </td>
                      <td
                        className="break-all px-3 py-2 font-mono text-xs"
                        style={{ color: 'var(--muted-color)' }}
                      >
                        {display}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                            style={{
                              borderColor: 'var(--border-color)',
                              color: 'var(--muted-color)',
                            }}
                            title="Copy path or URL to clipboard"
                            onClick={() => copyPath(display)}
                          >
                            Copy
                          </button>
                          <a
                            className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                            style={{
                              borderColor: 'var(--border-color)',
                              color: 'var(--muted-color)',
                            }}
                            title="Download artifact"
                            href={href}
                            download={a.name}
                            target={a.url ? '_blank' : undefined}
                            rel={a.url ? 'noopener noreferrer' : undefined}
                          >
                            Download
                          </a>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  )
}

/**
 * Minimal, cursor-pointer icon button with an accessible label. Kept
 * lightweight so BuildView's log toolbar reads as a tight cluster of
 * uniform affordances rather than three differently-styled buttons.
 */
function IconAction({
  onClick,
  disabled,
  title,
  label,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="inline-flex cursor-pointer items-center justify-center rounded-md border p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-black/5 dark:hover:bg-white/10"
      style={{
        borderColor: 'var(--border-color)',
        color: 'var(--muted-color)',
      }}
    >
      {children}
    </button>
  )
}

