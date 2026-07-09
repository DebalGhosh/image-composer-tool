import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Artifact } from '../api/types'

interface BuildViewProps {
  buildId: string
}

// Full MVP-1 build lifecycle. "not-started" is represented by not rendering this
// component at all; once a build exists it moves through the states below.
type Status = 'running' | 'cancelling' | 'cancelled' | 'success' | 'failed'

export function BuildView({ buildId }: BuildViewProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('running')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [cancelErr, setCancelErr] = useState<string>('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLogs([])
    setStatus('running')
    setArtifacts([])
    setErrorMsg('')
    setCancelErr('')

    const es = new EventSource(api.logsUrl(buildId))

    es.addEventListener('log', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data)
      setLogs((prev) => [...prev, message])
    })
    es.addEventListener('complete', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      // A build cancelled server-side still terminates via complete/error; honor
      // an explicit cancelled status if the backend reports one.
      setStatus(data.status === 'cancelled' ? 'cancelled' : 'success')
      setArtifacts(data.artifacts ?? [])
      es.close()
    })
    es.addEventListener('error', (e) => {
      const raw = (e as MessageEvent).data
      if (raw) {
        try {
          const data = JSON.parse(raw)
          setStatus(data.status === 'cancelled' ? 'cancelled' : 'failed')
          if (data.message) setErrorMsg(data.message)
        } catch {
          setStatus('failed')
        }
      }
      // A transport error with no data (connection drop) also ends the stream.
      es.close()
    })

    return () => es.close()
  }, [buildId])

  // Auto-scroll to the newest log line.
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [logs])

  const onCancel = async () => {
    setStatus('cancelling')
    setCancelErr('')
    try {
      await api.cancelBuild(buildId)
      // The terminal state (cancelled) arrives via the SSE complete/error event.
    } catch (e) {
      // The cancellation request itself failed — distinct from a build failure.
      setCancelErr((e as Error).message)
      setStatus('running') // still running; allow finish or retry
    }
  }

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

  const active = status === 'running' || status === 'cancelling'

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-[#00285a]">Build Status</h2>
        <StatusBadge status={status} />
        {active && (
          <button
            className="ml-auto rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            disabled={status === 'cancelling'}
            onClick={onCancel}
          >
            {status === 'cancelling' ? 'Cancelling…' : 'Cancel build'}
          </button>
        )}
      </div>

      {cancelErr && (
        <div className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
          Cancel request failed: {cancelErr}
        </div>
      )}
      {status === 'failed' && errorMsg && (
        <div className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700">Build failed: {errorMsg}</div>
      )}

      <div className="mb-2 flex gap-2">
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
          disabled={logs.length === 0}
          onClick={copyLogs}
        >
          Copy logs
        </button>
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
          disabled={logs.length === 0}
          onClick={downloadLogs}
        >
          Download logs
        </button>
      </div>

      <div
        ref={logRef}
        className="h-80 overflow-auto rounded-md bg-[#00285a] p-3 font-mono text-xs leading-relaxed text-slate-100"
      >
        {logs.length === 0 && <div className="text-slate-400">Waiting for build output…</div>}
        {logs.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap">
            {stripAnsi(line)}
          </div>
        ))}
      </div>

      {artifacts.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-[#00285a]">Artifacts</h3>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#e6f2fa] text-left">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Path</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((a) => (
                <tr key={a.path} className="border-b border-slate-200">
                  <td className="px-3 py-2">{a.name}</td>
                  <td className="px-3 py-2 uppercase">{a.type}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                      title={a.path}
                      onClick={() => copyPath(a.path)}
                    >
                      📋 Copy path
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

// The Go logger emits ANSI color codes; strip them for clean display.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '')
}
