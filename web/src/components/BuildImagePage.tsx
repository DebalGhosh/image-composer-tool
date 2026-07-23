/**
 * BuildImagePage — resizable split-pane layout for build monitoring.
 *
 * Mirror image of the Interactive tab's split, with the collapsible
 * pane on the LEFT instead of the right. Left pane hosts the session-
 * local build history (BuildHistoryList); right pane hosts the
 * currently-selected build's details + log (BuildView). Divider
 * chevron toggles the left pane between its remembered width and 0%.
 *
 * The two-pane state model:
 *   1. Session-persisted list of BuildHistoryEntry — `useBuildHistory()`
 *   2. Session-persisted selectedBuildId — also inside useBuildHistory
 *   3. Right pane renders <BuildView buildId={selectedBuildId ?? liveBuildId}/>
 *      where liveBuildId is the freshly-dispatched build not yet
 *      committed to selection (bridge for first render right after
 *      hitting Build Image).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { BuildView } from './BuildView'
import { BuildHistoryList } from './BuildHistoryList'
import type { BuildHistoryEntry } from '../lib/buildHistory'

type BuildStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

interface BuildImagePageProps {
  /** History-driven state (comes from App via useBuildHistory). */
  entries: BuildHistoryEntry[]
  selectedBuildId: string | null
  onSelect: (buildId: string) => void
  onDelete: (buildId: string) => void
  onClearAll: () => void
  /** Stop a running Jenkins build. See App.tsx onCancel wiring. */
  onCancel: (buildId: string) => Promise<void>
  /**
   * The most-recently-dispatched build. May not equal selectedBuildId
   * (a user could dispatch and then click an older row before this
   * runs, in which case they see the older row). Used only as a
   * fallback when history is empty but a fresh dispatch just landed.
   */
  liveBuildId: string | null
  /** Delegated to the right pane so retry from BuildView still works. */
  onRetry: () => Promise<void>
  retrying: boolean
  onStatusChange: (s: BuildStatus) => void
  /** Called by BuildView when Jenkins meta lands. Bubbled up to App. */
  onJenkinsMetaReady?: (
    buildId: string,
    worker: string,
    buildNo: number,
    buildUrl: string | null,
  ) => void
}

export function BuildImagePage({
  entries,
  selectedBuildId,
  onSelect,
  onDelete,
  onClearAll,
  onCancel,
  liveBuildId,
  onRetry,
  retrying,
  onStatusChange,
  onJenkinsMetaReady,
}: BuildImagePageProps) {
  // Auto-select the freshly-dispatched build when it lands, unless the
  // user has explicitly clicked a different history row since then.
  // This makes the common flow (dispatch → auto-jump to logs) still
  // work without extra clicks. If they DO click another row, we don't
  // ambush them back to the fresh one on the next Jenkins meta update.
  useEffect(() => {
    if (liveBuildId && selectedBuildId !== liveBuildId) {
      // Only auto-select if the live build IS in history AND nothing else
      // is currently selected. We don't want to yank focus off a row the
      // user just clicked.
      const inHistory = entries.some((e) => e.buildId === liveBuildId)
      if (inHistory && selectedBuildId === null) {
        onSelect(liveBuildId)
      }
    }
  }, [liveBuildId, selectedBuildId, entries, onSelect])

  // Which buildId should the right pane show? Precedence:
  //   1. explicit user selection
  //   2. live dispatch that hasn't been overridden by user click
  //   3. most-recent history entry
  //   4. null (empty state)
  const activeBuildId =
    selectedBuildId ??
    (liveBuildId && entries.some((e) => e.buildId === liveBuildId)
      ? liveBuildId
      : entries[0]?.buildId ?? null)

  /* -------------------- Left-pane collapse animation -------------------- */
  // Same pattern as Interactive's right-pane collapse (see
  // InteractivePage.tsx:205-243), reflected around the divider so it's
  // the LEFT pane that slides away to 0% width. `leftPanelRef` is the
  // ImperativePanelHandle we drive imperatively; `rafRef` tracks the
  // in-flight requestAnimationFrame so we can cancel on unmount.
  const leftPanelRef = useRef<ImperativePanelHandle | null>(null)
  const rafRef = useRef<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const lastExpandedSizeRef = useRef<number>(28) // sensible default width for history
  const [leftSizePct, setLeftSizePct] = useState<number>(28)

  const animatePanel = useCallback((toPercent: number, ms: number) => {
    const handle = leftPanelRef.current
    if (!handle) return
    const from = handle.getSize()
    if (Math.abs(from - toPercent) < 0.5) {
      handle.resize(toPercent)
      return
    }
    const start = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const size = from + (toPercent - from) * ease(t)
      handle.resize(size)
      if (t < 1) rafRef.current = requestAnimationFrame(step)
      else rafRef.current = null
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
  }, [])

  const toggle = useCallback(() => {
    const handle = leftPanelRef.current
    if (!handle) return
    if (collapsed) {
      setCollapsed(false)
      animatePanel(lastExpandedSizeRef.current, 420)
    } else {
      const current = handle.getSize()
      if (current > 5) lastExpandedSizeRef.current = current
      setCollapsed(true)
      animatePanel(0, 320)
    }
  }, [collapsed, animatePanel])

  // Clean up any in-flight RAF on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return (
    <div className="build-image-shell">
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <PanelGroup direction="horizontal" autoSaveId="ict.buildImage.split">
          <Panel
            ref={leftPanelRef}
            defaultSize={28}
            minSize={0}
            onResize={(sz) => setLeftSizePct(sz)}
            style={{ overflow: 'hidden' }}
          >
            <BuildHistoryList
              entries={entries}
              selectedBuildId={selectedBuildId}
              onSelect={onSelect}
              onDelete={onDelete}
              onClearAll={onClearAll}
              onCancel={onCancel}
            />
          </Panel>

          <PanelResizeHandle className="resize-handle group">
            <div className="resize-grip" aria-hidden />
          </PanelResizeHandle>

          <Panel defaultSize={72} minSize={30}>
            <div className="flex h-full flex-col p-6">
              <h1
                className="mb-4 flex-none text-2xl font-bold"
                style={{ color: 'var(--title-text)' }}
              >
                Monitor Builds
              </h1>
              {activeBuildId ? (
                // key={activeBuildId} forces a full remount when the user
                // clicks a different history row. Without the key BuildView's
                // buildId-scoped useEffect just re-runs — but in-flight
                // details polls and already-dispatched EventSource messages
                // from the OLD build could still land setState calls into the
                // SAME component instance, painting the new build's pane with
                // the old build's details/logs. Symptom in the wild:
                // "clicking a historical row selects some random other
                // build" — actually the selection was correct but the right
                // pane was showing leftover data from the previous build.
                <BuildView
                  key={activeBuildId}
                  buildId={activeBuildId}
                  onRetry={onRetry}
                  retrying={retrying}
                  onStatusChange={onStatusChange}
                  onJenkinsMetaReady={(worker, buildNo, buildUrl) =>
                    onJenkinsMetaReady?.(activeBuildId, worker, buildNo, buildUrl)
                  }
                />
              ) : (
                <div
                  className="rounded-md border border-dashed p-8 text-center text-sm"
                  style={{
                    borderColor: 'var(--border-color)',
                    color: 'var(--muted-color)',
                  }}
                >
                  No build selected. Dispatch one from another tab, or
                  <br />
                  click a row in the history panel.
                </div>
              )}
            </div>
          </Panel>
        </PanelGroup>

        {/*
         * Collapse toggle. Mirrors Interactive's chevron: pinned to the
         * divider via `left: {leftSizePct}%`. Chevron points LEFT when
         * expanded ("click to hide"), RIGHT when collapsed ("click to
         * show") — reflected from Interactive's version because THIS
         * pane collapses to the left, not the right.
         */}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Show build history' : 'Hide build history'}
          aria-pressed={collapsed}
          title={collapsed ? 'Show build history' : 'Hide build history'}
          className="cursor-pointer"
          style={{
            position: 'absolute',
            top: '50%',
            left: `max(calc(${leftSizePct}% - 14px), 8px)`,
            transform: 'translateY(-50%)',
            zIndex: 5,
            width: 28,
            height: 44,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            background: 'var(--section-background)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            color: 'var(--muted-color)',
            transition: 'color 160ms ease, background-color 160ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--font-color)'
            e.currentTarget.style.background =
              'color-mix(in srgb, var(--classic-blue) 8%, var(--section-background))'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted-color)'
            e.currentTarget.style.background = 'var(--section-background)'
          }}
        >
          <HistoryToggleChevron collapsed={collapsed} />
        </button>
      </div>

      <style>{`
        .build-image-shell {
          height: calc(100vh - 3.75rem);
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .build-image-shell .resize-handle {
          position: relative;
          width: 8px;
          background: transparent;
          transition: background-color 160ms ease;
          cursor: col-resize;
        }
        .build-image-shell .resize-handle:hover,
        .build-image-shell .resize-handle[data-panel-resize-handle-active] {
          background: color-mix(in srgb, var(--classic-blue) 25%, transparent);
        }
        .build-image-shell .resize-grip {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 2px;
          height: 40px;
          border-radius: 1px;
          background: var(--border-color);
          transition: background-color 160ms ease, height 160ms ease;
        }
        .build-image-shell .resize-handle:hover .resize-grip,
        .build-image-shell .resize-handle[data-panel-resize-handle-active] .resize-grip {
          background: var(--classic-blue);
          height: 60px;
        }
      `}</style>
    </div>
  )
}

/**
 * HistoryToggleChevron — chevron for the LEFT-pane collapse toggle.
 * Reflected from Interactive's PreviewToggleChevron:
 *   collapsed=false   90°   points LEFT   ("click to hide history")
 *   collapsed=true   -90°   points RIGHT  ("click to show history")
 */
function HistoryToggleChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden="true"
      style={{
        color: 'currentColor',
        transform: collapsed ? 'rotate(-90deg)' : 'rotate(90deg)',
        transition: 'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
      }}
    >
      <path
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
        fill="currentColor"
      />
    </svg>
  )
}
