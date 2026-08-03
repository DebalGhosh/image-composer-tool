import { useBuildStream } from './hooks/useBuildStream'
import { useTerminalFullscreen } from './hooks/useTerminalFullscreen'
import { BuildProgress } from '@/components/feedback/BuildProgress'
import { ArtifactsCard } from './parts/ArtifactsCard'
import { BuildDetailsCard } from './parts/BuildDetailsCard'
import { BuildLogCard } from './parts/BuildLogCard'
import { BuildSummaryPanels } from './parts/BuildSummaryPanels'
import { FailureBanner } from './parts/FailureBanner'
import { UnavailableNotice } from './parts/UnavailableNotice'
import type { BuildStatus } from '@/types/build'

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


/**
 * Container for one build's live view. Holds no presentation of its own beyond
 * the pane element and the ordering of six children:
 *
 *   stepper -> failure banner -> summary -> details -> log -> artifacts
 *
 * Everything stateful comes from two hooks (useBuildStream, which owns the SSE
 * stream, the poll and the one-shot Jenkins-metadata latch; and
 * useTerminalFullscreen). The clipboard/download callbacks stay here because
 * they close over `logs` and `buildId` and are handed to more than one child.
 */
export function BuildView({
  buildId,
  onRetry,
  retrying,
  onStatusChange,
  onJenkinsMetaReady,
}: BuildViewProps) {
  // SSE + the 5s poll + the one-shot Jenkins-metadata latch + 404 handling all
  // live in this one hook, and its dep array is [buildId] only — that is
  // load-bearing, not an oversight. See hooks/useBuildStream for why the four
  // concerns cannot be separated.
  const {
    logs,
    status,
    artifacts,
    details,
    unavailable,
    phase,
    install,
  } = useBuildStream({ buildId, onStatusChange, onJenkinsMetaReady })

  // Native fullscreen for the log terminal — see hooks/useTerminalFullscreen.
  const { terminalWrapRef, isFullscreen, toggleFullscreen } = useTerminalFullscreen()

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

  // Server has no record of this build — see parts/UnavailableNotice for why
  // this is a distinct state rather than a failure.
  if (unavailable) return <UnavailableNotice />


  return (
    /* Two responsibilities on this one element, both load-bearing:
     *
     * 1. @container — makes this pane the reference box for the `@max-pane-*`
     *    utilities below (the summary grid, the stepper connectors, the
     *    SummaryPanel key column). The right pane can be dragged to 30%, so a
     *    viewport query would measure a box more than three times too wide.
     *    Safe as a stacking context: BuildView imports no YamlEditor and no
     *    DialogOverlay, so it has no position:fixed descendant, and the
     *    terminal uses native requestFullscreen, which promotes to the
     *    browser's top layer and ignores containment entirely.
     *
     * 2. overflow-y-auto — this column stacks five flex-none blocks above one
     *    flex-1 grower, and Panel injects `overflow: hidden`, so without a
     *    scroll container short screens CLIP instead of scrolling and the
     *    Artifacts card becomes unreachable at 720px tall.
     *
     *    The usual trap does not apply: making a flex container scrollable is
     *    only fatal if its height goes auto (then flex-1 + min-h-0 resolves
     *    the terminal to 0 and TerminalLog's clientHeight===0 guard makes
     *    fit() bail permanently). Height stays DEFINITE here — this is
     *    `flex-1 min-h-0` inside BuildImagePage's `h-full` — so overflow-y
     *    only changes what happens once content exceeds the box. */
    <div className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {/* The stepper stays mounted through EVERY terminal state, which is a
          deliberate reversal of how this used to work:
            - failure/cancel: the step where things stopped flashes red, so the
              user sees at a glance whether the break was early (dispatch) or
              late (publish);
            - success: all seven steps green, sitting directly above the
              populated Artifacts card. That is the whole point of the
              `publishing` step — the server holds it for the entire 1-2 min
              Artifactory upload and emits `done` alongside the `complete` event
              carrying the links, so "Publishing artifacts ✓" and the hyperlinks
              land in the same paint. Unmounting on success (as this once did)
              meant the all-green frame was never rendered at all. */}
      <BuildProgress
        phase={phase}
        install={install}
        failed={status === 'failed' || status === 'cancelled'}
      />

      {(status === 'failed' || status === 'cancelled') && (
        <FailureBanner status={status} retrying={retrying} onRetry={onRetry} />
      )}

      {details?.summary && <BuildSummaryPanels summary={details.summary} />}

      {details && (
        <BuildDetailsCard
          details={details}
          buildId={buildId}
          copyCommand={copyCommand}
        />
      )}

      <BuildLogCard
        logs={logs}
        terminalWrapRef={terminalWrapRef}
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        copyLogs={copyLogs}
        downloadLogs={downloadLogs}
      />

      {(artifacts.length > 0 || details?.jenkins?.artifactoryUrl) && (
        <ArtifactsCard
          artifacts={artifacts}
          details={details}
          buildId={buildId}
          copyPath={copyPath}
        />
      )}
    </div>
  )
}
