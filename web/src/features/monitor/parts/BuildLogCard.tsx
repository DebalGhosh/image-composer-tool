import { Card } from '@/components/layout/Card'
import { TerminalLog } from '@/components/feedback/TerminalLog'

/**
 * The build log terminal and its three-button toolbar — the star of this pane.
 *
 * The terminal surface is hard-coded #1e1e1e in BOTH app themes, matching the
 * YAML editor and the command <pre> in BuildDetailsCard — the "code surfaces"
 * family. Not a stranded token; do not theme it.
 *
 * `terminalWrapRef` and the fullscreen state come from useTerminalFullscreen in
 * the parent rather than being owned here, because the ref must be attached to
 * the element the browser promotes into the top layer and the parent's
 * `.terminal-fullscreen-host:fullscreen` CSS rule keys off that same element.
 *
 * Extracted verbatim from BuildView, including the min-h/flex commentary, which
 * explains a real layout fix and must not be trimmed.
 */
export function BuildLogCard({
  logs,
  terminalWrapRef,
  isFullscreen,
  toggleFullscreen,
  copyLogs,
  downloadLogs,
}: {
  logs: string[]
  terminalWrapRef: React.RefObject<HTMLDivElement | null>
  isFullscreen: boolean
  toggleFullscreen: () => void
  copyLogs: () => void
  downloadLogs: () => void
}) {
  return (
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
      /* The floor REPLACES the old min-h-0 (both set min-height, so keeping
       * both would just be a specificity coin-flip). flex-1 is untouched:
       * on a tall screen this still stretches exactly as before — no change
       * at 1920x1080 — but on a short one the floor stops the five flex-none
       * siblings from squeezing the terminal toward zero. The deficit goes
       * to the parent's overflow-y instead, so Artifacts stays reachable.
       *
       * Shrink-to-zero is still available where it's actually needed: the
       * inner terminal wrapper below keeps its own min-h-0.
       *
       * min-h rather than a fixed h- so native fullscreen needs no
       * !important — `.terminal-fullscreen-host:fullscreen`'s height:100vh
       * already beats a min-height of 18rem. */
      className="flex min-h-[var(--term-min-h)] flex-1 flex-col"
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
