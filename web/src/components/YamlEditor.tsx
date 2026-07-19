import { useCallback, useMemo, useRef } from 'react'
import CodeMirror, {
  EditorView,
  keymap,
  Prec,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
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
 *   - Escape is intentionally NOT trapped: keyboard-only users press Esc
 *     then Tab to move focus out of the editor. Standard CodeMirror a11y.
 *   - Line wrapping is OFF: YAML is indentation-sensitive and soft-wrapped
 *     lines can visually mislead operators about indent depth.
 *   - `onCreateEditor` wires aria-labelledby onto the contenteditable so
 *     screen-readers announce the field label — the outer wrapper `id` alone
 *     wouldn't provide that association (divs are not label targets).
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
}: YamlEditorProps) {
  const themeMode = useStore((s) => s.theme)
  const cmRef = useRef<ReactCodeMirrorRef | null>(null)

  const themeExt = useMemo(
    () => (themeMode === 'dark' ? vscodeDark : vscodeLight),
    [themeMode],
  )

  const extensions = useMemo(
    () => [
      yaml(),
      // Prec.highest so our Tab binding wins over any lower-precedence default.
      Prec.highest(tabInsertTwoSpaces),
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
      }),
    ],
    [],
  )

  const basicSetup = useMemo(
    () => ({
      lineNumbers: true,
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      bracketMatching: true,
      foldGutter: true,
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
    <div id={id} className={className}>
      <CodeMirror
        ref={cmRef}
        value={value}
        height={height}
        style={{ height }}
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
