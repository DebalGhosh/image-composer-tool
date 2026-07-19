import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../store'
import type { Artifact, BuildDetails } from '../api/types'
import { Card } from './Card'
import { SummaryPanel } from './SummaryPanel'

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
  const logRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  useEffect(() => {
    setLogs([])
    setStatus('running')
    setArtifacts([])
    setDetails(null)
    setDetailsOpen(false)

    // Fetch the command + resolved template paths for the troubleshoot panel.
    // Best-effort: a failure here shouldn't disrupt the log stream.
    api.buildDetails(buildId).then(setDetails).catch(() => {})

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
    es.addEventListener('error', (e) => {
      const raw = (e as MessageEvent).data
      if (raw) {
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
      }
      es.close()
    })

    return () => es.close()
  }, [buildId])

  // Auto-scroll to the newest log line.
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [logs])

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
    <div className="mt-6">
      <Card
        title={
          <span className="flex items-center gap-3">
            Build Status
            <StatusBadge status={status} />
          </span>
        }
        actions={
          (status === 'failed' || status === 'cancelled') ? (
            <button
              className="rounded border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
              style={{ borderColor: 'var(--classic-blue)', color: 'var(--classic-blue)' }}
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? 'Starting…' : '↺ Retry build'}
            </button>
          ) : undefined
        }
        className="mb-4"
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
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-slate-600">
                <dt className="font-sans font-semibold">Work dir</dt>
                <dd className="break-all">{details.workDir}</dd>
                <dt className="font-sans font-semibold">Cache dir</dt>
                <dd className="break-all">{details.cacheDir}</dd>
              </dl>
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
      >
        <div
          ref={logRef}
          className="h-[32rem] overflow-auto rounded-md bg-[#00285a] p-3 font-mono text-xs leading-relaxed text-slate-100"
        >
          {logs.length === 0 && <div className="text-slate-400">Waiting for build output…</div>}
          {logs.map((line, i) => {
            const clean = cleanLine(line)
            if (clean === '') return null
            return (
              <div key={i} className="whitespace-pre">
                {clean}
              </div>
            )
          })}
        </div>
      </Card>

      {artifacts.length > 0 && (
        <Card title="Artifacts" className="mt-4">
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
              {artifacts.map((a) => (
                <tr key={a.path} className="border-b" style={{ borderColor: 'var(--border-color)' }}>
                  <td className="px-3 py-2 font-mono text-xs">{a.name}</td>
                  <td className="px-3 py-2 uppercase">{a.type}</td>
                  <td className="px-3 py-2 font-mono text-xs break-all" style={{ color: 'var(--muted-color)' }}>{a.path}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ borderColor: 'var(--border-color)' }}
                        title="Copy path to clipboard"
                        onClick={() => copyPath(a.path)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy path
                      </button>
                      <a
                        className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ borderColor: 'var(--border-color)' }}
                        title="Download artifact"
                        href={`/api/v1/builds/${buildId}/artifacts/${encodeURIComponent(a.name)}`}
                        download={a.name}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Download
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

// Clean a raw log line for display:
// 1. Strip all ANSI/VT100 escape sequences (color, cursor movement, line-clear, etc.)
// 2. Handle carriage returns the way a terminal would — keep only what follows
//    the last \r, so progress-bar overwrites show their final state rather than
//    producing a blank line after the content.
function cleanLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b[^[]/g, '').replace(/\x1b/g, '')
  const cr = stripped.lastIndexOf('\r')
  return cr >= 0 ? stripped.slice(cr + 1) : stripped
}
