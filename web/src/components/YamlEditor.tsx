import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import CodeMirror, {
  EditorView,
  keymap,
  Prec,
  type Extension,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { foldGutter } from '@codemirror/language'
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode'
import { useStore } from '../store'

export interface YamlEditorProps {
  value: string
  onChange: (next: string) => void
  readOnly?: boolean
  /** CSS height for the editor viewport, e.g. '480px'. Defaults to '480px'. */
  height?: string
  /** Rendered by CodeMirror when the buffer is empty. */
  placeholder?: string
  /** DOM id used as the aria-labelledby target's referenced id. */
  id?: string
  /** Id of the associated <label>/<span> element (for aria-labelledby). */
  labelledBy?: string
  /** Extra Tailwind classes for the outer wrapper (border, focus ring, etc.). */
  className?: string
  /** Additional CodeMirror extensions appended to the built-in set (yaml,
   * tab-handler, base theme). Used by callers who want to inject
   * decorations, StateFields, or extra themes without forking this
   * component. Memoise the array upstream so extensions don't re-register
   * on every parent render. */
  extraExtensions?: Extension[]
}

// Custom Tab handler: insert two spaces at the caret rather than a literal tab
// character. This keeps YAML valid without pulling in @codemirror/commands or
// @codemirror/language (which would push us over the dep budget).
const tabInsertTwoSpaces = keymap.of([
  {
    key: 'Tab',
    run: ({ state, dispatch }) => {
      if (state.readOnly) return false
      dispatch(
        state.update(state.replaceSelection('  '), {
          scrollIntoView: true,
          userEvent: 'input',
        }),
      )
      return true
    },
    shift: ({ state, dispatch }) => {
      // Simple dedent: if the two chars immediately before the caret are two
      // spaces, delete them. Any wider dedent behavior is intentionally out of
      // scope for MVP-1 — advanced users can highlight lines and press Tab
      // from the far-left column to re-indent, matching the old <textarea>.
      if (state.readOnly) return false
      const from = state.selection.main.from
      if (from < 2) return false
      const before = state.doc.sliceString(from - 2, from)
      if (before !== '  ') return false
      dispatch(
        state.update({
          changes: { from: from - 2, to: from },
          userEvent: 'delete',
        }),
      )
      return true
    },
  },
])

// -------------------------------------------------------------------------
// Cross-instance fullscreen coordinator.
//
// Requirement 9: only one YamlEditor may be fullscreen at a time. Rather than
// hoist state into a context (which would drag every consumer into the
// design), we keep a tiny module-level singleton and let instances subscribe.
// When any editor owns fullscreen, other instances hide their expand button
// so two overlays can never coexist.
// -------------------------------------------------------------------------
let activeFullscreenOwner: string | null = null
const fullscreenListeners = new Set<() => void>()

function setFullscreenOwner(id: string | null) {
  activeFullscreenOwner = id
  fullscreenListeners.forEach((cb) => cb())
}

function subscribeFullscreen(cb: () => void): () => void {
  fullscreenListeners.add(cb)
  return () => {
    fullscreenListeners.delete(cb)
  }
}

// Inline SVG icons (kept tiny to avoid a lucide-react-style dep). 16px viewBox.
function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
    </svg>
  )
}

function CollapseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
    </svg>
  )
}

// Path/viewBox copied from the accordion Card's Chevron so the fold-gutter
// markers speak the same visual vocabulary as every other "reveal/dismiss"
// affordance in the app. Uses raw DOM (not React) because CodeMirror's
// FoldGutterConfig.markerDOM callback must return an HTMLElement.
const FOLD_CHEVRON_PATH =
  'M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z'
const FOLD_CHEVRON_VIEWBOX = '0 0 20 20'
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build a marker element for the fold gutter. `open=true` means the line
 * IS foldable (currently open) — chevron points down, inviting a fold.
 * `open=false` means the line is currently folded — chevron rotated -90°
 * (points right, standard "closed" affordance).
 */
function buildFoldChevron(open: boolean): HTMLSpanElement {
  const wrap = document.createElement('span')
  // Inline-flex so the wrap sizes to the SVG and centers vertically inside
  // the gutter row. Muted color matches the surrounding line-number tone.
  wrap.style.display = 'inline-flex'
  wrap.style.alignItems = 'center'
  wrap.style.justifyContent = 'center'
  wrap.style.width = '14px'
  wrap.style.height = '14px'
  wrap.style.cursor = 'pointer'
  wrap.setAttribute('aria-hidden', 'true')

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', FOLD_CHEVRON_VIEWBOX)
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.style.color = 'currentColor'
  // Down when open (matches accordion "open=points down" convention).
  // -90° when folded so it points right, echoing the standard tree-node
  // "closed" marker without breaking the shared chevron shape.
  svg.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)'
  svg.style.transition = 'transform 180ms cubic-bezier(0.22, 0.7, 0.32, 1)'

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', FOLD_CHEVRON_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  wrap.appendChild(svg)
  return wrap
}

/**
 * YAML editor wrapping CodeMirror 6.
 *
 * Design decisions:
 *   - Line numbers + YAML syntax highlight + bracket matching + fold gutter
 *     (from basicSetup + lang-yaml).
 *   - Theme extension memoised on the store's `theme` field so light/dark
 *     swaps are a prop update, not a remount — cursor/scroll/undo survive.
 *   - Custom Tab command inserts two spaces (matches the previous
 *     <textarea>'s `tabSize: 2`). Shift-Tab dedents by up to two spaces.
 *   - Escape is intentionally NOT trapped in normal mode: keyboard-only users
 *     press Esc then Tab to move focus out of the editor. In fullscreen mode
 *     Escape closes fullscreen (see below).
 *   - Line wrapping is OFF: YAML is indentation-sensitive and soft-wrapped
 *     lines can visually mislead operators about indent depth.
 *   - `onCreateEditor` wires aria-labelledby onto the contenteditable so
 *     screen-readers announce the field label — the outer wrapper `id` alone
 *     wouldn't provide that association (divs are not label targets).
 *
 * Fullscreen (LeetCode-style):
 *   - Approach B: toggle the SAME wrapper to position:fixed inset-0 z-60.
 *     CodeMirror stays mounted through the transition, so cursor position,
 *     scroll offset, and undo history all survive. The consumer never sees
 *     the fullscreen state — it's fully encapsulated here.
 *   - Only the CodeMirror `height` prop is swapped (to `calc(100vh - 52px)`)
 *     so the editor re-layouts to fill the viewport without a remount.
 *   - Escape closes; focus is trapped between the toggle button and the CM
 *     contenteditable (the only two focusable landmarks in the overlay).
 *   - Body scroll locked while fullscreen. Only one editor may fullscreen at
 *     a time (module-level singleton); other instances hide their button.
 */
export function YamlEditor({
  value,
  onChange,
  readOnly = false,
  height = '480px',
  placeholder,
  id,
  labelledBy,
  className,
  extraExtensions,
}: YamlEditorProps) {
  const themeMode = useStore((s) => s.theme)
  const cmRef = useRef<ReactCodeMirrorRef | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Stable per-instance id used as the singleton ownership token.
  const instanceId = useId()

  const [isFullscreen, setIsFullscreen] = useState(false)

  // Re-render on singleton changes so we can hide the button when another
  // instance owns fullscreen.
  const [, bump] = useState(0)
  useEffect(
    () => subscribeFullscreen(() => bump((n) => n + 1)),
    [],
  )
  const anotherOwnsFullscreen =
    activeFullscreenOwner !== null && activeFullscreenOwner !== instanceId

  const themeExt = useMemo(
    () => (themeMode === 'dark' ? vscodeDark : vscodeLight),
    [themeMode],
  )

  const extensions = useMemo(
    () => [
      yaml(),
      // Prec.highest so our Tab binding wins over any lower-precedence default.
      Prec.highest(tabInsertTwoSpaces),
      // Explicit fold gutter with a custom marker so the collapse/expand
      // affordance on YAML blocks (arrays, nested maps) uses the SAME
      // chevron glyph as the accordion Card headers. basicSetup's default
      // foldGutter is disabled below so this doesn't stack.
      foldGutter({ markerDOM: buildFoldChevron }),
      EditorView.theme({
        '&': { fontSize: '13px' },
        '.cm-scroller': {
          fontFamily:
            "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace)",
          lineHeight: '1.5',
          overflow: 'auto',
        },
        '.cm-content': { padding: '8px 0' },
        '.cm-gutters': { userSelect: 'none' },
        // Give the fold-gutter chevrons a bit of breathing room and a
        // muted tone that lifts on hover (matches the accordion chevron's
        // muted-then-brighter feel).
        '.cm-foldGutter': {
          color: 'var(--muted-color)',
          minWidth: '16px',
        },
        '.cm-foldGutter .cm-gutterElement': {
          padding: '0 2px',
        },
        '.cm-foldGutter .cm-gutterElement:hover': {
          color: 'var(--font-color)',
        },
      }),
      // Caller-provided extensions (line-diff decorations, custom themes)
      // are appended last so they can override earlier registrations if needed.
      ...(extraExtensions ?? []),
    ],
    [extraExtensions],
  )

  const basicSetup = useMemo(
    () => ({
      lineNumbers: true,
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      bracketMatching: true,
      // Disable the default fold gutter — we register our own above with
      // a matching-chevron markerDOM. Leaving this true would stack two
      // gutters next to each other.
      foldGutter: false,
      autocompletion: false,
      searchKeymap: true,
      history: true,
    }),
    [readOnly],
  )

  const onCreateEditor = useCallback(
    (view: EditorView) => {
      if (labelledBy) {
        const content = view.contentDOM
        content.setAttribute('aria-labelledby', labelledBy)
      }
    },
    [labelledBy],
  )

  const enterFullscreen = useCallback(() => {
    // Guard: refuse if another instance already owns fullscreen. In practice
    // the button is hidden on other instances, but this belt-and-braces
    // check prevents races if the button flickers.
    if (activeFullscreenOwner !== null && activeFullscreenOwner !== instanceId) {
      return
    }
    setFullscreenOwner(instanceId)
    setIsFullscreen(true)
  }, [instanceId])

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    if (activeFullscreenOwner === instanceId) {
      setFullscreenOwner(null)
    }
  }, [instanceId])

  // Release the singleton if this instance unmounts while owning it (e.g.
  // LiveYamlPreview remounts on `beat` change).
  useEffect(
    () => () => {
      if (activeFullscreenOwner === instanceId) {
        setFullscreenOwner(null)
      }
    },
    [instanceId],
  )

  // Body scroll lock + document-level Escape listener while fullscreen.
  useEffect(() => {
    if (!isFullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        exitFullscreen()
      }
    }
    // Capture phase so we win against CodeMirror's own key handling.
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey, true)
    }
  }, [isFullscreen, exitFullscreen])

  // Focus containment (defense-in-depth): while fullscreen, if focus ever
  // escapes the wrapper (e.g. Tab out of CodeMirror's search panel, browser
  // chrome, an inadvertently focused sibling), pull it back to the toggle
  // button. This complements the wrapper's onKeyDown trap and handles cases
  // the trap doesn't enumerate (search panel inputs, future focusables).
  useEffect(() => {
    if (!isFullscreen) return
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null
      if (target && !wrapper.contains(target)) {
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [isFullscreen])

  // Focus management: when entering fullscreen, focus the toggle button (it
  // now shows the collapse icon and is one of the two focus landmarks). On
  // exit, focus stays on that same button since it's the same DOM node.
  useEffect(() => {
    if (isFullscreen) {
      buttonRef.current?.focus()
    }
  }, [isFullscreen])

  // Focus trap: cycle Tab / Shift+Tab between the toggle button and the
  // CodeMirror contenteditable. Only active in fullscreen.
  //
  // CRITICAL: In editable mode, CodeMirror's Prec.highest Tab keymap consumes
  // Tab and calls preventDefault (but not stopPropagation) — so this React
  // handler still fires on the bubble-phase delegated listener. We MUST NOT
  // steal focus in that case, or every Tab keystroke would insert two spaces
  // AND yank focus to the toggle button. The `e.defaultPrevented` short-circuit
  // handles this: when CM (or any other handler) has already preventDefaulted
  // the Tab, we leave focus alone. The trap therefore only fires when CM
  // deliberately let Tab through (readOnly mode, or Shift+Tab-without-dedent).
  const onWrapperKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isFullscreen || e.key !== 'Tab') return
      // If CM's Tab keymap consumed the event, don't interfere. This is what
      // fixes the "Tab inserts spaces AND boots focus" bug in editable mode.
      if (e.defaultPrevented) return
      const btn = buttonRef.current
      const cm = cmRef.current?.view?.contentDOM
      if (!btn || !cm) return
      const active = document.activeElement

      // Forward Tab from within CM (only reached when CM did NOT preventDefault,
      // i.e. readOnly or fell-through Shift+Tab): trap back to the button.
      if (!e.shiftKey && (active === cm || cm.contains(active))) {
        e.preventDefault()
        btn.focus()
        return
      }
      // Forward Tab from button → into CM.
      if (!e.shiftKey && active === btn) {
        e.preventDefault()
        cm.focus()
        return
      }
      // Shift+Tab from button → into CM.
      if (e.shiftKey && active === btn) {
        e.preventDefault()
        cm.focus()
        return
      }
      // Shift+Tab from CM → back to button.
      if (e.shiftKey && (active === cm || cm.contains(active))) {
        e.preventDefault()
        btn.focus()
        return
      }
    },
    [isFullscreen],
  )

  // Merge className (border, ring, etc.) with fullscreen-only overrides that
  // must beat consumer classes: edge-to-edge (no border-radius), solid page
  // background, and viewport-sized fixed positioning above the sticky header
  // (which is z-40).
  const wrapperStyle: CSSProperties = isFullscreen
    ? {
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 60,
        background: 'var(--page-background)',
        borderRadius: 0,
        borderWidth: 0,
        margin: 0,
        // Small breathing room around CM for the toolbar and edges.
        padding: '40px 12px 12px 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        animation:
          'yaml-editor-fs-in 200ms cubic-bezier(0.22, 0.7, 0.32, 1) both',
        // Own stacking context so the button stays above CM.
        display: 'block',
      }
    : {
        // Establish a positioning context so the absolute-positioned expand
        // button anchors to this wrapper (not to some ancestor). Kept minimal
        // so consumer className border/rounded/height utilities still apply.
        position: 'relative',
      }

  // In fullscreen, hand CodeMirror an explicit viewport-relative height that
  // subtracts our wrapper padding — it re-layouts without unmounting.
  const cmHeight = isFullscreen ? 'calc(100vh - 52px)' : height

  return (
    <div
      ref={wrapperRef}
      id={id}
      className={className}
      style={wrapperStyle}
      onKeyDown={onWrapperKeyDown}
      // In fullscreen the wrapper acts like a modal region.
      role={isFullscreen ? 'dialog' : undefined}
      aria-modal={isFullscreen ? true : undefined}
      // Prefer labelledby when the consumer wired one (AdvancedPage). Fall back
      // to a static aria-label for consumers that render inside their own
      // labelled panel (LiveYamlPreview) so the dialog is still announced.
      aria-labelledby={isFullscreen && labelledBy ? labelledBy : undefined}
      aria-label={isFullscreen && !labelledBy ? 'YAML editor (fullscreen)' : undefined}
    >
      {/* Local keyframe — mounted alongside the wrapper so the animation can
          only ever apply when this editor is on screen. Small enough that a
          second copy from a second YamlEditor mount is harmless. */}
      <style>{`
        @keyframes yaml-editor-fs-in {
          from { opacity: 0; transform: scale(0.98); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* Toggle button. Hidden when another editor owns fullscreen so two
          overlays can never coexist (requirement 9). */}
      {!anotherOwnsFullscreen && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => (isFullscreen ? exitFullscreen() : enterFullscreen())}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Expand editor to fullscreen'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Expand editor'}
          style={{
            position: 'absolute',
            top: isFullscreen ? 8 : 6,
            right: isFullscreen ? 12 : 6,
            zIndex: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 4,
            border: '1px solid var(--border-color)',
            background: 'var(--input-background)',
            color: 'var(--muted-color)',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--font-color)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted-color)'
          }}
        >
          {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      )}

      <CodeMirror
        ref={cmRef}
        value={value}
        height={cmHeight}
        style={{ height: cmHeight }}
        theme={themeExt}
        extensions={extensions}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={basicSetup}
        onCreateEditor={onCreateEditor}
        onChange={onChange}
      />
    </div>
  )
}
