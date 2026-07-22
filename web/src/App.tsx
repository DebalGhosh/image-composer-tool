import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import { useStore, useToast } from './store'
import { BasicPage } from './components/BasicPage'
import { AdvancedPage } from './components/AdvancedPage'
import { InteractivePage } from './components/InteractivePage'
import { BuildImagePage } from './components/BuildImagePage'
import { Header } from './components/Header'
import { ToastContainer } from './components/toast/ToastContainer'
import { useBuildHistory } from './lib/buildHistory'
import {
  readUrlState,
  replaceUrlState,
  type View,
} from './lib/urlState'

type LoadState = 'loading' | 'ready' | 'error'
type BuildStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

export default function App() {
  const setManifest = useStore((s) => s.setManifest)
  const toast = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  // URL is the SOURCE OF TRUTH for view only. Build history is entirely
  // browser-local (localStorage via useBuildHistory) — the URL
  // deliberately carries no worker/buildNo/buildId. That means a URL is
  // not shareable to point at a build; the trade-off is intentional
  // (per user request).
  const initialUrl = readUrlState()
  const [view, setView] = useState<View>(initialUrl.view)
  const [retrying, setRetrying] = useState(false)
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('idle')
  // Most-recently-dispatched buildId — used purely as a bridge so the
  // right pane auto-jumps to a fresh dispatch. Once the user clicks a
  // history row we stop honouring this (see BuildImagePage's auto-select
  // effect).
  const [liveBuildId, setLiveBuildId] = useState<string | null>(null)
  // Last YAML submitted. Retry replays this instead of the Basic selection
  // when the last build came from Interactive or Advanced.
  const lastYamlRef = useRef<string | null>(null)

  const {
    entries,
    addEntry,
    updateEntry,
    deleteEntry,
    clearAll,
    selectedBuildId,
    setSelectedBuildId,
  } = useBuildHistory()

  // Reflect view into the URL whenever it changes. Only view — no build
  // deep-link fields any more.
  useEffect(() => {
    replaceUrlState({ view })
  }, [view])

  // Handle browser back/forward: re-parse the URL and update view.
  useEffect(() => {
    const onPop = () => {
      const u = readUrlState()
      setView(u.view)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const load = useCallback(() => {
    setState('loading')
    setError(null)
    api
      .getManifest()
      .then((m) => {
        setManifest(m)
        setState('ready')
      })
      .catch((e) => {
        const msg = (e as Error).message
        setError(msg)
        setState('error')
        toast.danger(msg, {
          title: 'Failed to load configuration',
          duration: 0,
        })
      })
  }, [setManifest, toast])

  useEffect(load, [load])

  const onBuildStarted = (id: string, yaml?: string) => {
    lastYamlRef.current = yaml ?? null
    addEntry({
      buildId: id,
      worker: null,
      buildNo: null,
      startedAt: Date.now(),
      status: 'running',
      jenkinsBuildUrl: null,
      jenkinsJobUrl: null,
    })
    setLiveBuildId(id)
    setSelectedBuildId(id)
    setBuildStatus('running')
    setView('builds')
  }

  // BuildImagePage calls this when its active BuildView first observes
  // populated jenkins.worker/buildNumber. We patch the corresponding
  // history entry.
  const onBuildJenkinsMetaReady = useCallback(
    (
      buildId: string,
      worker: string,
      buildNo: number,
      buildUrl: string | null,
    ) => {
      updateEntry(buildId, { worker, buildNo, jenkinsBuildUrl: buildUrl })
    },
    [updateEntry],
  )

  // Status transitions from the active BuildView. We patch the entry
  // matching liveBuildId (the freshly-dispatched build) so status pills
  // in the history list stay live. If the user has selected a different
  // history row the child BuildView won't fire onStatusChange for the
  // live build; we mirror onto the selected row instead — that's the row
  // the user is watching. Fall back to liveBuildId otherwise.
  const onBuildStatusChange = useCallback(
    (s: BuildStatus) => {
      setBuildStatus(s)
      const targetId = selectedBuildId ?? liveBuildId
      if (targetId) {
        updateEntry(targetId, { status: s })
      }
    },
    [selectedBuildId, liveBuildId, updateEntry],
  )

  const onCancelBuild = useCallback(
    async (buildId: string) => {
      try {
        await api.cancelBuild(buildId)
        // Backend flipped status to "cancelled" atomically; mirror it
        // locally so the row's pill flips immediately without waiting
        // for the SSE 'error' event.
        updateEntry(buildId, { status: 'cancelled' })
        // If the cancelled build is the one driving buildStatus, flip
        // that too so the header pill goes idle-ish.
        const targetId = selectedBuildId ?? liveBuildId
        if (buildId === targetId) {
          setBuildStatus('cancelled')
        }
      } catch (e) {
        toast.danger((e as Error).message, { title: 'Cancel failed' })
        throw e
      }
    },
    [toast, updateEntry, selectedBuildId, liveBuildId],
  )

  const onRetry = useCallback(async () => {
    // Retry is surfaced by BuildView when the current build is in a
    // terminal error state, so lastYamlRef is always populated.
    const yaml = lastYamlRef.current
    if (yaml == null) return
    setRetrying(true)
    setBuildStatus('running')
    try {
      const accepted = await api.dispatchJenkins(yaml)
      addEntry({
        buildId: accepted.buildId,
        worker: null,
        buildNo: null,
        startedAt: Date.now(),
        status: 'running',
        jenkinsBuildUrl: null,
        jenkinsJobUrl: null,
      })
      setLiveBuildId(accepted.buildId)
      setSelectedBuildId(accepted.buildId)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Retry failed' })
    } finally {
      setRetrying(false)
    }
  }, [toast, addEntry, setSelectedBuildId])

  return (
    <div className="min-h-full">
      <Header
        view={view}
        onViewChange={setView}
        buildStatus={buildStatus}
        onBuildIndicatorClick={() => setView('builds')}
      />

      {state === 'loading' && (
        <div className="m-6 text-sm text-[var(--muted-color)]">Loading configuration…</div>
      )}

      {state === 'error' && (
        <div className="m-6 text-sm" style={{ color: 'var(--muted-color)' }}>
          <p>Failed to load configuration: {error}</p>
          <p className="mt-1">Is the API server running on :8080?</p>
          <button
            className="mt-3 rounded border px-3 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
            style={{
              borderColor: 'var(--classic-blue)',
              color: 'var(--classic-blue)',
            }}
            onClick={load}
          >
            Retry
          </button>
        </div>
      )}

      {state === 'ready' && (
        <>
          <div hidden={view !== 'basic'}>
            <BasicPage
              onBuildStarted={onBuildStarted}
              buildInProgress={buildStatus === 'running'}
            />
          </div>
          <div hidden={view !== 'advanced'}>
            <AdvancedPage
              onBuildStarted={onBuildStarted}
              buildInProgress={buildStatus === 'running'}
            />
          </div>
          <div hidden={view !== 'interactive'}>
            <InteractivePage
              onBuildStarted={onBuildStarted}
              buildInProgress={buildStatus === 'running'}
            />
          </div>
          <div hidden={view !== 'builds'}>
            <BuildImagePage
              entries={entries}
              selectedBuildId={selectedBuildId}
              onSelect={setSelectedBuildId}
              onDelete={deleteEntry}
              onClearAll={clearAll}
              onCancel={onCancelBuild}
              liveBuildId={liveBuildId}
              onRetry={onRetry}
              retrying={retrying}
              onStatusChange={onBuildStatusChange}
              onJenkinsMetaReady={onBuildJenkinsMetaReady}
            />
          </div>
        </>
      )}

      <ToastContainer />
    </div>
  )
}
