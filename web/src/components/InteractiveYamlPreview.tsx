import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { YamlEditor } from './YamlEditor'
import {
  createDiffHighlightController,
  diffChangedLines,
} from '../lib/yamlDiffHighlight'

interface InteractiveYamlPreviewProps {
  /**
   * Pre-computed YAML string. The parent (InteractivePage) is responsible for
   * running `applyOverrides` against the current draft on every change and
   * passing the resulting YAML.stringify output here. Keeping the stringify
   * upstream lets the parent share the same rendered YAML with adjacent
   * consumers (dispatch, diff, download) without recomputing.
   */
  yaml: string
  /**
   * Coarse-grained mode for the panel:
   *  - 'empty'  → no seed has been picked yet; show the stub instructions.
   *  - 'ready'  → yaml prop is trustworthy and should be rendered.
   *  - 'error'  → applyOverrides threw; show the message in `error`.
   */
  status: 'empty' | 'ready' | 'error'
  /** Human-readable error text, shown only when status === 'error'. */
  error?: string
}

/**
 * Read-only YAML preview for the Interactive tab.
 *
 * Mirrors the chrome of {@link LiveYamlPreview} — status pill, copy button,
 * bordered body with an opacity-only fade — but does NO fetching. The parent
 * owns the seed manifest and the draft state, applies overrides, and passes
 * the resulting YAML string down. This keeps the preview purely presentational
 * so it can re-render on every keystroke in the Interactive editor without
 * touching the network.
 *
 * The wrapper is keyed on `yaml.length + status` so any change to the
 * rendered content replays the fade-in keyframe. Length is a cheap proxy for
 * "content changed" that also avoids remounting on identical strings; the
 * status suffix ensures transitions between empty/ready/error also animate.
 */
export function InteractiveYamlPreview({
  yaml,
  status,
  error,
}: InteractiveYamlPreviewProps) {
  const theme = useStore((s) => s.theme)

  const showStub = status === 'empty'
  const showError = status === 'error'
  const showYaml = status === 'ready'

  // Diff-highlight controller. Memoised so its extensions array is
  // reference-stable across renders (YamlEditor's useMemo depends on it).
  const highlight = useMemo(() => createDiffHighlightController(), [])

  // Track the previous YAML so we can compute the changed lines on every
  // new value. Ref lives across renders without triggering re-renders itself.
  const prevYamlRef = useRef<string>('')
  useEffect(() => {
    if (status !== 'ready') {
      // Reset the baseline so the first successful render after an
      // empty/error phase doesn't try to diff against a stale doc.
      prevYamlRef.current = yaml
      return
    }
    const prev = prevYamlRef.current
    // Update the ref BEFORE dispatching the flash so a mid-flight
    // re-render still sees the latest baseline (dispatch is sync — the
    // editor picks up the effect on next paint).
    prevYamlRef.current = yaml
    const changed = diffChangedLines(prev, yaml)
    if (changed.length > 0) highlight.flash(changed)
  }, [yaml, status, highlight])

  const pillLabel =
    status === 'empty'
      ? 'No seed loaded'
      : status === 'error'
        ? 'Preview unavailable'
        : 'Live preview'

  const pillColor =
    status === 'ready'
      ? 'var(--success)'
      : status === 'error'
        ? 'var(--danger)'
        : 'var(--muted-color)'

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: 'var(--muted-color)' }}
        >
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: pillColor,
              transition: 'background-color 200ms ease',
            }}
          />
          <span>{pillLabel}</span>
        </div>
        {showYaml && <CopyButton text={yaml} />}
      </div>

      <div
        className="preview-transition min-h-0 flex-1 overflow-hidden rounded-md border"
        style={{
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
        }}
        // The stub/error/yaml sub-tree keeps its own key so those transitions
        // still play. CodeMirror lives OUTSIDE that key branch — we no longer
        // remount it on every yaml change because the diff-highlight state
        // must survive across doc updates for the flash decorations to fade
        // in-place. Non-yaml status swaps still get the fade via the inner key.
      >
        <div key={`stub-${status}`}>
          {showStub && <StubPanel />}
          {showError && <ErrorPanel message={error ?? 'Unknown error'} />}
        </div>
        {showYaml && (
          <YamlEditor
            value={yaml}
            onChange={() => {}}
            readOnly
            height="100%"
            className="h-full"
            extraExtensions={highlight.extensions}
          />
        )}
      </div>

      {/* Local keyframe: opacity-only fade as fresh YAML lands.
       *
       * Note: intentionally NOT animating `transform: translateY` here — while
       * the animation runs, `transform` establishes a containing block for
       * fixed-position descendants (CSS spec). That would trap the child
       * YamlEditor's fullscreen overlay inside this wrapper. Keeping the swap
       * opacity-only is enough visual signal that a new draft has resolved. */}
      <style>{`
        .preview-transition > * {
          animation: yaml-swap 260ms ease-out;
        }
        @keyframes yaml-swap {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
      {/* Suppress `theme` unused warning while keeping the dep so future
          themed-viewer tweaks can pull it in easily. */}
      <div hidden data-theme={theme} />
    </div>
  )
}

function StubPanel() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div style={{ color: 'var(--muted-color)' }}>
        <p className="text-sm">
          Pick a seed template on the left to start editing.
        </p>
        <p className="mt-1 text-xs opacity-70">
          The preview refreshes every time you change a field in the
          Interactive editor.
        </p>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="grid h-full place-items-center p-6 text-center"
      style={{ color: 'var(--danger-fg)' }}
    >
      <div>
        <p className="text-sm font-semibold">Preview unavailable</p>
        <p className="mt-1 font-mono text-xs opacity-80">{message}</p>
      </div>
    </div>
  )
}

/**
 * GitHub-style copy icon button with a transient "Copied!" affordance.
 *
 * Swaps the clipboard glyph for a checkmark for ~1.5s after a successful
 * write, and shows a floating chip so the confirmation is unmistakable
 * even for users who read the icon peripherally. Uses the async clipboard
 * API with a synchronous execCommand fallback for non-HTTPS localhost
 * environments where `navigator.clipboard` isn't available.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for insecure origins (some corporate dev hosts): drop a
        // hidden textarea, select, execCommand, remove. Deprecated but the
        // only path when navigator.clipboard is blocked.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Silent — the user will see the icon didn't flip and can retry.
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied to clipboard' : 'Copy YAML to clipboard'}
        title={copied ? 'Copied!' : 'Copy YAML'}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded border transition-colors hover:bg-black/5 dark:hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)]"
        style={{
          borderColor: 'var(--border-color)',
          color: copied ? 'var(--success)' : 'var(--muted-color)',
        }}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </button>
      {/* Floating chip. Positioned ABOVE the button so it never gets clipped
       *  by the YAML editor rendered directly below the header. Fades via
       *  opacity + a small slide, pointer-events:none so the chip never eats
       *  a second click. */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-full mb-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold shadow-sm"
        style={{
          background: 'var(--success)',
          color: 'white',
          opacity: copied ? 1 : 0,
          transform: copied ? 'translateY(0)' : 'translateY(4px)',
          transition:
            'opacity 160ms ease, transform 160ms cubic-bezier(0.22, 0.7, 0.32, 1)',
        }}
      >
        Copied!
      </span>
    </div>
  )
}

// GitHub's octicon-copy paths, condensed. 16px viewBox.
function ClipboardIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  )
}
