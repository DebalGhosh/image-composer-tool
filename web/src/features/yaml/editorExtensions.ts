import { EditorView, keymap, Prec, type Extension } from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { foldGutter } from '@codemirror/language'
import { buildFoldChevron } from './parts/foldChevron'

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
 * The CodeMirror extensions every YamlEditor gets, in registration order.
 *
 * A module CONSTANT rather than a `useMemo` in the component: nothing here reads
 * a prop or a piece of state. The previous
 * `useMemo(() => [...], [extraExtensions])` rebuilt this entire array —
 * including a fresh `EditorView.theme()` — whenever the caller's extension array
 * changed identity, which for a caller that forgot to memoise meant
 * re-registering the theme on every parent render.
 *
 * Consumer extensions are appended AFTER these by the component, so a caller can
 * still override any registration here.
 *
 * The `var(--…)` references inside EditorView.theme() are the editor's share of
 * the app's theme tokens. The browser resolves them at paint time against
 * whichever theme class is on <html>, which is why ONE static object serves both
 * themes — the vscodeDark/vscodeLight swap is a separate extension and that one
 * genuinely does depend on state.
 */
export const BASE_EXTENSIONS: Extension[] = [
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
    // Hide the inline "…" placeholder chip that CodeMirror renders in
    // place of folded ranges. The gutter chevron already communicates
    // the fold state; the chip adds visual noise inside otherwise
    // clean YAML. `visibility: hidden` collapses the chip visually
    // while KEEPING the element in the DOM — we still need it there
    // as an anchor for the `:has()` selector below that tints the
    // enclosing line.
    '.cm-foldPlaceholder': {
      visibility: 'hidden',
      // Zero-width so the line's text layout matches an unfolded
      // line (no phantom gap where "…" used to sit).
      fontSize: 0,
      padding: 0,
      margin: 0,
    },
    // Tint the entire line that hosts a folded range so users can see
    // at a glance "this row hides more content beneath it". A soft
    // classic-blue wash matches the diff-highlight family used by
    // Interactive YAML preview edits, and stays subtle enough to
    // read comfortably in both light and dark themes.
    '.cm-line:has(.cm-foldPlaceholder)': {
      backgroundColor:
        'color-mix(in srgb, var(--classic-blue) 12%, transparent)',
      boxShadow:
        'inset 2px 0 0 0 color-mix(in srgb, var(--classic-blue) 60%, transparent)',
    },
    // Same tint but a touch stronger on hover so the affordance
    // "click this to unfold" gets a subtle bump.
    '.cm-line:has(.cm-foldPlaceholder):hover': {
      backgroundColor:
        'color-mix(in srgb, var(--classic-blue) 18%, transparent)',
    },
  }),
]
