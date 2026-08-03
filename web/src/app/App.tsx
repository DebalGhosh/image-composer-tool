import { BasicPage } from '@/features/compose-basic'
import { AdvancedPage } from '@/features/compose-advanced'
import { InteractivePage } from '@/features/compose-interactive'
import { BuildImagePage } from '@/features/monitor'
import { Header } from '@/app/Header'
import { ToastContainer } from '@/components/feedback/toast/ToastContainer'
import { useBuildLifecycle } from './hooks/useBuildLifecycle'
import { useManifestLoader } from './hooks/useManifestLoader'
import { useUrlView } from './hooks/useUrlView'
import { ManifestErrorScreen } from './parts/ManifestErrorScreen'

/**
 * The app shell: header, the manifest gate, and the four pages.
 *
 * ⚠️ ALL FOUR PAGES ARE MOUNTED AT ONCE, hidden with `hidden={view !== …}`. This
 * is NOT a routing oversight and must not be replaced with a router:
 *   - InteractivePage's Cmd+K handler reads `offsetParent === null` to tell that
 *     its own tab is off screen. That works only because the element exists
 *     inside a `display: none` subtree — unmounting would make the shortcut fire
 *     from every tab.
 *   - Composer drafts live in the store, but each page's LOCAL state (scroll
 *     offset, open accordions, a half-typed field) survives a tab switch purely
 *     because nothing is torn down.
 * See .claude/UI-LAYOUT.md.
 *
 * State lives in three hooks: useUrlView (tab <-> URL), useManifestLoader (the
 * fetch and its three states), useBuildLifecycle (dispatch, status, cancel,
 * retry, and the persisted history).
 */
export default function App() {
  const { view, setView } = useUrlView()
  const { state, error, retry } = useManifestLoader()
  const {
    entries,
    deleteEntry,
    clearAll,
    selectedBuildId,
    setSelectedBuildId,
    buildStatus,
    liveBuildId,
    retrying,
    onBuildStarted,
    onBuildJenkinsMetaReady,
    onBuildStatusChange,
    onCancelBuild,
    onRetry,
  } = useBuildLifecycle({ setView })

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

      {state === 'error' && <ManifestErrorScreen error={error} onRetry={retry} />}

      {state === 'ready' && (
        <>
          <div hidden={view !== 'basic'}>
            <BasicPage
              onBuildStarted={onBuildStarted}
            />
          </div>
          <div hidden={view !== 'advanced'}>
            <AdvancedPage
              onBuildStarted={onBuildStarted}
            />
          </div>
          <div hidden={view !== 'interactive'}>
            <InteractivePage
              onBuildStarted={onBuildStarted}
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
