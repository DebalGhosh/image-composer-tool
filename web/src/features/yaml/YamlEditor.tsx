import { useCallback, useId, useMemo, useRef } from 'react'
import CodeMirror, {
  type EditorView,
  type Extension,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror'
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode'
import { BASE_EXTENSIONS } from './editorExtensions'
import { useStore } from '@/store'
import { useYamlFullscreen } from './hooks/useYamlFullscreen'
import { FullscreenToggle } from './parts/FullscreenToggle'

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


// The cross-instance fullscreen coordinator, the toggle glyphs and the
// fold-gutter marker builder all moved out in FE-7a. See
// fullscreenRegistry.ts for why the coordinator is a module singleton rather
// than a context, and parts/foldChevron.ts for why that one is imperative DOM.

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

  // Fullscreen lives in its own hook: seven interlocking concerns keyed on one
  // flag, plus the singleton that guarantees only one overlay app-wide.
  // See hooks/useYamlFullscreen.
  const {
    isFullscreen,
    anotherOwnsFullscreen,
    enterFullscreen,
    exitFullscreen,
    onWrapperKeyDown,
    wrapperStyle,
    cmHeight,
  } = useYamlFullscreen({ instanceId, buttonRef, wrapperRef, cmRef, height })

  const themeExt = useMemo(
    () => (themeMode === 'dark' ? vscodeDark : vscodeLight),
    [themeMode],
  )

  // Consumer extensions after the base set so a caller can override any of it.
  // Only this concat depends on props — the base array is a module constant, so
  // the theme is registered once per module rather than once per render.
  const extensions = useMemo(
    () => [...BASE_EXTENSIONS, ...(extraExtensions ?? [])],
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
        <FullscreenToggle
          isFullscreen={isFullscreen}
          buttonRef={buttonRef}
          onEnter={enterFullscreen}
          onExit={exitFullscreen}
        />
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
