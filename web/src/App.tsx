import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import { useStore, useToast } from './store'
import { BasicPage } from './components/BasicPage'
import { AdvancedPage } from './components/AdvancedPage'
import { BuildImagePage } from './components/BuildImagePage'
import { Header } from './components/Header'
import { ToastContainer } from './components/toast/ToastContainer'

type LoadState = 'loading' | 'ready' | 'error'
type View = 'basic' | 'advanced' | 'builds'
type BuildStatus = 'idle' | 'running' | 'success' | 'failed'

export default function App() {
  const setManifest = useStore((s) => s.setManifest)
  const toast = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [view, setView] = useState<View>('basic')
  const [buildId, setBuildId] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('idle')
  // Last YAML submitted from the Advanced tab. Retry replays this instead of
  // the Basic selection when the last build came from the Advanced path.
  const lastYamlRef = useRef<string | null>(null)

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
    setBuildId(id)
    setBuildStatus('running')
    setView('builds')
  }

  const onBuildStatusChange = (s: BuildStatus) => setBuildStatus(s)

  const onRetry = useCallback(async () => {
    // Retry only appears in BuildView after a build has completed as failed or
    // cancelled, so lastYamlRef is always set by the time we get here.
    const yaml = lastYamlRef.current
    if (yaml == null) return
    setRetrying(true)
    setBuildStatus('running')
    try {
      const accepted = await api.dispatchJenkins(yaml)
      setBuildId(accepted.buildId)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Retry failed' })
    } finally {
      setRetrying(false)
    }
  }, [toast])

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
          <div hidden={view !== 'builds'}>
            <BuildImagePage
              buildId={buildId}
              onRetry={onRetry}
              retrying={retrying}
              onStatusChange={onBuildStatusChange}
            />
          </div>
        </>
      )}

      <ToastContainer />
    </div>
  )
}
