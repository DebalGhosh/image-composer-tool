import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../store'
import type { Artifact, BuildDetails } from '../api/types'
import { Card } from './Card'
import { SummaryPanel } from './SummaryPanel'
import { TerminalLog } from './TerminalLog'

type BuildStatus = 'idle' | 'running' | 'success' | 'failed'

interface BuildViewProps {
  buildId: string
  onRetry: () => Promise<void>
  retrying: boolean
  onStatusChange: (s: BuildStatus) => void
}

// Full MVP-1 build lifecycle. "not-started" is represented by not rendering this
// component at all; once a build exists it moves through the states below.
type Status = 'running' | 'cancelling' | 'cancelled' | 'success' | 'failed'

export function BuildView({ buildId, onRetry, retrying, onStatusChange }: BuildViewProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('running')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [details, setDetails] = useState<BuildDetails | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const toast = useToast()

  useEffect(() => {
    setLogs([])
    setStatus('running')
    setArtifacts([])
    setDetails(null)
    setDetailsOpen(false)

    // Fetch build details on mount, then poll every 5 s until we've seen
    // both a Jenkins buildNumber AND the Artifactory URL. The URL only
    // surfaces after the PUBLISH stage echoes it -- polling avoids adding
    // another event type to the SSE contract just for this one field.
    // The interval is cheap (a JSON GET against localhost) and stops as
    // soon as the URL lands or the SSE stream reports a terminal state.
    let stopPolling = false
    const pollDetails = async () => {
      try {
        const d = await api.buildDetails(buildId)
        setDetails(d)
        if (d.jenkins?.artifactoryUrl) return // done; stop scheduling
      } catch {
        /* transient, keep polling */
      }
      if (!stopPolling) setTimeout(pollDetails, 5000)
    }
    pollDetails()

    const es = new EventSource(api.logsUrl(buildId))

    es.addEventListener('log', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data)
      setLogs((prev) => [...prev, message])
    })
    es.addEventListener('complete', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      const s = data.status === 'cancelled' ? 'cancelled' : 'success'
      setStatus(s)
      setArtifacts(data.artifacts ?? [])
      onStatusChange(s === 'success' ? 'success' : 'idle')
      es.close()
    })
    // NAMED 'error' events carry a JSON payload from the server -- those are
    // terminal (build failed / cancelled) and we should close the stream.
    // The DEFAULT EventSource error event, dispatched on transport-layer
    // hiccups (idle-timeout on a proxy, brief TCP reset, browser buffer flush),
    // has NO `data` field and the browser will auto-reconnect on its own if
    // we leave the EventSource open. Closing on those was killing the stream
    // after the first minor hiccup.
    es.addEventListener('error', (e) => {
      const raw = (e as MessageEvent).data
      if (!raw) {
        // Native transport error. readyState === 0 (CONNECTING) means the
        // browser is already reconnecting; readyState === 2 (CLOSED) means
        // the server sent a real closure and we should stop trying.
        if (es.readyState === EventSource.CLOSED) {
          setStatus((prev) => (prev === 'running' ? 'failed' : prev))
          onStatusChange('failed')
        }
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
        onStatusChange('failed')
      } catch {
        setStatus('failed')
        onStatusChange('failed')
      }
      es.close()
    })

    return () => {
      stopPolling = true
      es.close()
    }
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Card
        title={
          <span className="flex items-center gap-3">
            Build Status
            <StatusBadge status={status} />
            {details?.jenkins?.worker && (
              <span
                className="rounded px-2 py-0.5 text-[11px] font-medium"
                style={{
                  background: 'color-mix(in srgb, var(--classic-blue) 12%, transparent)',
                  color: 'var(--classic-blue)',
                }}
                title="Worker Jenkins picked for this build"
              >
                {details.jenkins.worker}
                {details.jenkins.buildNumber ? ` · #${details.jenkins.buildNumber}` : ''}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {(details?.jenkins?.buildUrl || details?.jenkins?.jobUrl) && (
              <a
                className="rounded border px-3 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                style={{ borderColor: 'var(--classic-blue)', color: 'var(--classic-blue)' }}
                href={details.jenkins.buildUrl || details.jenkins.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the running build (or the worker job) in Jenkins"
              >
                ↗ View in Jenkins
              </a>
            )}
            {(status === 'failed' || status === 'cancelled') && (
              <button
                className="rounded border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
                style={{ borderColor: 'var(--classic-blue)', color: 'var(--classic-blue)' }}
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? 'Starting…' : '↺ Retry build'}
              </button>
            )}
          </div>
        }
        className="flex-none"
      >

      {/* Failure message is surfaced via toast.danger from the SSE 'error' handler,
          so we don't render an inline red banner here anymore. */}

      {/* Collapsible troubleshoot panel: the exact command, the resolved template
          (downloadable), and the per-build work/cache directories. Collapsed by
          default so it doesn't compete with the log for space. */}
      {details && (
        <div
          className="rounded-md border"
          style={{
            borderColor: 'var(--border-color)',
            background: 'color-mix(in srgb, var(--page-background) 60%, var(--section-background))',
          }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: 'var(--muted-color)' }}
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
          >
            <span style={{ color: 'var(--muted-color)' }}>{detailsOpen ? '▼' : '▶'}</span>
            Build details
            <span className="font-normal" style={{ color: 'var(--muted-color)' }}>— command, template, paths</span>
          </button>
          {detailsOpen && (
            <div className="space-y-4 border-t px-3 py-3 text-xs" style={{ borderColor: 'var(--border-color)' }}>

              {/* Selection + image configuration summary */}
              {details.summary && (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <SummaryPanel
                    heading="Your Selection"
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
                    heading="Image Configuration"
                    rows={
                      [
                        ['Image', `${details.summary.imageName}${details.summary.imageVersion ? ` (v${details.summary.imageVersion})` : ''}`],
                        details.summary.description ? ['Description', details.summary.description] : null,
                        ['Architecture', details.summary.architecture],
                        details.summary.kernelVersion ? ['Kernel', details.summary.kernelVersion] : null,
                        ['Packages', `${details.summary.packageCount} packages`],
                        details.summary.diskSize ? ['Disk', `${details.summary.diskSize}${details.summary.partitionTable ? `, ${details.summary.partitionTable.toUpperCase()}` : ''}${details.summary.partitionCount ? `, ${details.summary.partitionCount} partitions` : ''}`] : null,
                        details.summary.hostname ? ['Hostname', details.summary.hostname] : null,
                      ] as ([string, string] | null)[]
                    }
                  />
                </div>
              )}

              {/* Command */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-semibold text-slate-600">Command</span>
                  <button
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] hover:bg-white"
                    onClick={copyCommand}
                  >
                    📋 Copy
                  </button>
                </div>
                <pre className="overflow-x-auto rounded bg-[#00285a] p-2 font-mono text-[11px] leading-relaxed text-slate-100">
                  {details.command}
                </pre>
              </div>

              {/* Template + dirs */}
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-600">Template</span>
                <span className="font-mono text-slate-700">{details.template}</span>
                <a
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] hover:bg-white"
                  href={api.templateUrl(buildId)}
                  download={details.template}
                >
                  ⬇ Download
                </a>
              </div>
              {/* Jenkins metadata (dispatched path). Local-build panel just
                  gets Work dir / Cache dir; Jenkins gets Worker + Build URL. */}
              {details.jenkins ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-slate-600">
                  <dt className="font-sans font-semibold">Worker</dt>
                  <dd className="break-all">{details.jenkins.worker}</dd>
                  {details.jenkins.buildNumber ? (
                    <>
                      <dt className="font-sans font-semibold">Build #</dt>
                      <dd className="break-all">
                        <a
                          className="underline"
                          style={{ color: 'var(--classic-blue)' }}
                          href={details.jenkins.buildUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {details.jenkins.buildNumber}
                        </a>
                      </dd>
                    </>
                  ) : null}
                  <dt className="font-sans font-semibold">Job</dt>
                  <dd className="break-all">
                    <a
                      className="underline"
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
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-slate-600">
                    {details.workDir && (
                      <>
                        <dt className="font-sans font-semibold">Work dir</dt>
                        <dd className="break-all">{details.workDir}</dd>
                      </>
                    )}
                    {details.cacheDir && (
                      <>
                        <dt className="font-sans font-semibold">Cache dir</dt>
                        <dd className="break-all">{details.cacheDir}</dd>
                      </>
                    )}
                  </dl>
                )
              )}
            </div>
          )}
        </div>
      )}
      </Card>

      <Card
        title="Build Log"
        actions={
          <>
            <button
              className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
              style={{ borderColor: 'var(--border-color)' }}
              disabled={logs.length === 0}
              onClick={copyLogs}
              title="Copy logs to clipboard"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy logs
            </button>
            <button
              className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
              style={{ borderColor: 'var(--border-color)' }}
              disabled={logs.length === 0}
              onClick={downloadLogs}
              title="Download logs as a file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download logs
            </button>
          </>
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* min-h-0 is critical on flex children -- default min-height:auto
            would prevent the terminal from shrinking below its content
            size, breaking the flex-1 grow behavior. */}
        <div
          className="min-h-0 flex-1 overflow-hidden rounded-md"
          style={{
            background: 'var(--terminal-background, #0b1220)',
            padding: '8px',
          }}
        >
          {logs.length === 0 ? (
            <div className="p-3 font-mono text-xs" style={{ color: 'var(--muted-color)' }}>
              Waiting for build output…
            </div>
          ) : (
            <TerminalLog logs={logs} className="h-full" />
          )}
        </div>
      </Card>

      {(artifacts.length > 0 || details?.jenkins?.artifactoryUrl) && (
        <Card title="Artifacts" className="flex-none">
          {artifacts.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ background: 'color-mix(in srgb, var(--classic-blue) 12%, var(--section-background))' }}>
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
                const href = a.url ?? `/api/v1/builds/${buildId}/artifacts/${encodeURIComponent(a.name)}`
                const display = a.path ?? a.url ?? a.name
                return (
                  <tr key={`${a.name}-${i}`} className="border-b" style={{ borderColor: 'var(--border-color)' }}>
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
                    <td className="px-3 py-2 uppercase">{a.type}</td>
                    <td className="px-3 py-2 font-mono text-xs break-all" style={{ color: 'var(--muted-color)' }}>{display}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ borderColor: 'var(--border-color)' }}
                          title="Copy path or URL to clipboard"
                          onClick={() => copyPath(display)}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                          Copy
                        </button>
                        <a
                          className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ borderColor: 'var(--border-color)' }}
                          title="Download artifact"
                          href={href}
                          download={a.name}
                          target={a.url ? '_blank' : undefined}
                          rel={a.url ? 'noopener noreferrer' : undefined}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
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

          {details?.jenkins?.artifactoryUrl && (
            <div
              className={
                'flex flex-wrap items-center gap-3 text-xs ' +
                // Add a top border + spacing ONLY when the file table above
                // it is rendered. When mid-build (table empty, URL only),
                // the row IS the card body, so a floating separator would
                // sit under nothing and read as visual noise.
                (artifacts.length > 0 ? 'mt-3 border-t pt-3' : '')
              }
              style={{ borderColor: 'var(--border-color)' }}
            >
              <span
                className="font-semibold"
                style={{ color: 'var(--muted-color)' }}
              >
                📦 Published to Artifactory
              </span>
              <a
                className="flex-1 truncate font-mono underline"
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
                  className="flex items-center gap-1 rounded border px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ borderColor: 'var(--border-color)' }}
                  title="Copy Artifactory URL to clipboard"
                  onClick={() => details.jenkins && copyPath(details.jenkins.artifactoryUrl!)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  Copy URL
                </button>
                <a
                  className="flex items-center gap-1 rounded border px-2 py-1 font-medium hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ borderColor: 'var(--classic-blue)', color: 'var(--classic-blue)' }}
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
        </Card>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  const cls: Record<Status, string> = {
    running: 'bg-amber-100 text-amber-800',
    cancelling: 'bg-amber-100 text-amber-800',
    cancelled: 'bg-slate-200 text-slate-700',
    success: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  }
  const label: Record<Status, string> = {
    running: 'Building…',
    cancelling: 'Cancelling…',
    cancelled: '⊘ Cancelled',
    success: '✓ Completed',
    failed: '✗ Failed',
  }
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls[status]}`}>{label[status]}</span>
}

