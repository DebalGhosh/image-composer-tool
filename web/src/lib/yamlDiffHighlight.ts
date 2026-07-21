// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0
//
// Live-diff highlight extension for the Interactive YAML preview.
//
// The parent computes a fresh YAML string on every draft change and hands it
// to the `<YamlEditor>` via its `value` prop. We flash the lines that just
// changed so the operator can see, at a glance, which section of the template
// their sliders/dropdowns updated.
//
// Key design decisions:
//   • A single `StateField<DecorationSet>` holds the currently-highlighted
//     line ranges. On `update.docChanged` it re-maps existing decorations,
//     so scrolling and viewport re-layout don't drop them.
//   • `flashLinesEffect(lines, epoch)` marks new ranges. Each range carries
//     the epoch counter so a later `clearEpochEffect(epoch)` (queued on
//     setTimeout) removes only the ranges from that specific dispatch —
//     never a concurrent one.
//   • Fade is CSS: a `@keyframes yaml-line-flash-anim` animates the
//     background from a soft classic-blue tint down to transparent.
//   • CodeMirror virtualises rendering — only lines currently in the
//     viewport have `.cm-line` DOM nodes. A line decoration whose target
//     line isn't rendered leaves the class attached to nothing, so nothing
//     paints. `flash()` therefore dispatches an `EditorView.scrollIntoView`
//     alongside the effect, guaranteeing the changed line lands in the
//     viewport before the paint. The scroll also doubles as a useful
//     affordance: the user's eye gets pointed straight at what changed.
//   • CSS is injected as a single `<style id="yaml-diff-highlight-style">`
//     tag rather than via `EditorView.baseTheme` — baseTheme prepends
//     `.cm-editor` to every top-level rule, which mangles `@keyframes` and
//     interacts unpredictably with the vscode-theme extension.

import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

// ---------------------------------------------------------------------------
// Line diff — Longest-Common-Subsequence line-level. O(n·m) memory but n and
// m are ≤ a few hundred lines for a typical ICT template, so this is fine.
// Returns the 1-indexed line numbers in `next` that don't have an equivalent
// unchanged line in `prev` (i.e., inserted or modified).
// ---------------------------------------------------------------------------

export function diffChangedLines(prev: string, next: string): number[] {
  const a = prev.split('\n')
  const b = next.split('\n')

  // Trivial cases short-circuit — prevents allocating O(n·m) LCS grid on
  // first-ever preview where prev='' (n=1, m~200 which is fine, but skipping
  // the grid is still cheaper and clearer).
  if (prev === next) return []
  if (prev === '') {
    // Highlighting every line on the very first render would flood the
    // viewport. Suppress the flash on the initial swap; subsequent edits
    // will diff normally.
    return []
  }

  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[0..i) vs b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      dp[i][j] = ai === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Walk back from (n, m). A line in `b` counts as "unchanged" iff it lies on
  // an LCS pair; every OTHER line in `b` is a change we want to flash.
  const unchanged = new Set<number>() // 1-indexed line in b
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      unchanged.add(j) // b's j-th line is on the LCS
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  const changed: number[] = []
  for (let k = 1; k <= m; k++) if (!unchanged.has(k)) changed.push(k)
  return changed
}

// ---------------------------------------------------------------------------
// CodeMirror wiring
// ---------------------------------------------------------------------------

/**
 * Effect payload — a list of 1-indexed line numbers and the epoch that owns
 * them. Epoch lets us clear only the ranges added in a specific dispatch
 * without disturbing decorations from a concurrent flash.
 */
const flashLinesEffect = StateEffect.define<{ lines: number[]; epoch: number }>()
const clearEpochEffect = StateEffect.define<number>()

/**
 * Line-background decoration. The CSS `yaml-line-flash` class animates the
 * background from a soft classic-blue tint down to transparent over the
 * highlight lifetime. See createDiffHighlightExtension() below for the
 * baseTheme() that owns the CSS.
 */
const flashDeco = (epoch: number) =>
  Decoration.line({
    attributes: {
      class: 'yaml-line-flash',
      // data-epoch is only used for eventual DevTools debugging — no logic
      // depends on it (StateField holds the authoritative epoch state).
      'data-flash-epoch': String(epoch),
    },
  })

/**
 * The StateField that stores active decorations plus each range's epoch.
 * We can't stash the epoch on the Decoration itself (RangeValue metadata is
 * opaque to the outside), so we track it in a parallel Map keyed by anchor
 * position. On clearEpochEffect(e) we rebuild the DecorationSet without any
 * ranges whose epoch === e.
 */
interface DecoState {
  set: DecorationSet
  // Per-decoration epoch, indexed by the starting position (which is stable
  // across doc changes because line decorations are anchored at line start).
  epochByPos: Map<number, number>
}

function emptyState(): DecoState {
  return { set: Decoration.none, epochByPos: new Map() }
}

const diffField = StateField.define<DecoState>({
  create: () => emptyState(),
  update(prev, tr) {
    let next = prev
    // Re-map positions if the doc changed. Line decorations survive
    // insertion/deletion via CodeMirror's built-in position mapping.
    if (tr.docChanged) {
      const mappedSet = prev.set.map(tr.changes)
      const mappedEpochs = new Map<number, number>()
      // Rebuild the epoch map by walking the mapped decoration set and
      // asking each decoration for its (new) start position.
      const iter = mappedSet.iter()
      while (iter.value) {
        const oldEntry = [...prev.epochByPos.entries()].find(([oldPos]) => {
          // Map old pos through the transaction to see if it maps to `iter.from`.
          return tr.changes.mapPos(oldPos, -1) === iter.from
        })
        if (oldEntry) {
          mappedEpochs.set(iter.from, oldEntry[1])
        }
        iter.next()
      }
      next = { set: mappedSet, epochByPos: mappedEpochs }
    }

    for (const effect of tr.effects) {
      if (effect.is(flashLinesEffect)) {
        const { lines, epoch } = effect.value
        // Build a fresh RangeSet from the union of existing decorations +
        // new ones, then merge back into the state.
        const builder = new RangeSetBuilder<Decoration>()
        const doc = tr.state.doc
        // First: replay existing decorations (in position order).
        // Second: add new ones.
        // RangeSetBuilder requires monotonic positions, so we merge into a
        // sorted list first.
        interface Item {
          pos: number
          deco: Decoration
          epoch: number
        }
        const items: Item[] = []
        const iter = next.set.iter()
        while (iter.value) {
          const e = next.epochByPos.get(iter.from) ?? 0
          items.push({ pos: iter.from, deco: iter.value, epoch: e })
          iter.next()
        }
        const newEpochMap = new Map(next.epochByPos)
        for (const ln of lines) {
          if (ln < 1 || ln > doc.lines) continue
          const pos = doc.line(ln).from
          // Drop any existing decoration at this same line-start so we don't
          // stack two decorations on the same position (CodeMirror allows it
          // but the second animation would restart the first).
          const idx = items.findIndex((it) => it.pos === pos)
          if (idx >= 0) items.splice(idx, 1)
          items.push({ pos, deco: flashDeco(epoch), epoch })
          newEpochMap.set(pos, epoch)
        }
        items.sort((x, y) => x.pos - y.pos)
        for (const it of items) builder.add(it.pos, it.pos, it.deco)
        next = { set: builder.finish(), epochByPos: newEpochMap }
      }
      if (effect.is(clearEpochEffect)) {
        const drop = effect.value
        const builder = new RangeSetBuilder<Decoration>()
        const kept = new Map<number, number>()
        const iter = next.set.iter()
        while (iter.value) {
          const e = next.epochByPos.get(iter.from) ?? 0
          if (e !== drop) {
            builder.add(iter.from, iter.from, iter.value)
            kept.set(iter.from, e)
          }
          iter.next()
        }
        next = { set: builder.finish(), epochByPos: kept }
      }
    }

    return next
  },
  provide: (f) => EditorView.decorations.from(f, (state) => state.set),
})

// -----------------------------------------------------------------------------
// CSS injection.
//
// We deliberately bypass `EditorView.baseTheme` here. baseTheme prepends
// `.cm-editor` to every top-level rule via a CSS-in-JS pass — that breaks
// `@keyframes` blocks (browsers silently drop `.cm-editor @keyframes`) and
// interacts unpredictably with theme extensions that scope their own rules.
//
// A single idempotent <style> tag in <head> sidesteps all of that: rules are
// exactly what we write, keyframes register normally, and specificity is
// completely under our control.
// -----------------------------------------------------------------------------
const STYLE_TAG_ID = 'yaml-diff-highlight-style'
function ensureStyleTagInjected(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_TAG_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_TAG_ID
  // Classic-blue (rgb 37,99,235) with a 3px inset left bar for a clear
  // affordance even after the background fades. rgba (not color-mix) so we
  // support Chrome < 111 environments some ICT operators still run.
  style.textContent = `
    .cm-editor .cm-line.yaml-line-flash {
      background-color: rgba(37, 99, 235, 0.28) !important;
      box-shadow: inset 3px 0 0 0 rgba(37, 99, 235, 0.9) !important;
      animation: yaml-line-flash-anim 1200ms ease-out forwards !important;
    }
    @keyframes yaml-line-flash-anim {
      0%   { background-color: rgba(37, 99, 235, 0.42) !important; }
      60%  { background-color: rgba(37, 99, 235, 0.22) !important; }
      100% { background-color: rgba(37, 99, 235, 0)    !important; }
    }
  `
  document.head.appendChild(style)
}

// Extension that just ensures the <style> tag is installed once, per view.
// (Injecting once at module load would work too, but doing it in an extension
// keeps the side effect co-located with the editor lifecycle.)
const styleInjector = EditorView.updateListener.of(() => {
  ensureStyleTagInjected()
})

/**
 * A diff-highlight controller. Owns the CodeMirror extension bundle and
 * exposes a `flash(lines)` method the parent React component calls after
 * running {@link diffChangedLines}. Internally captures the view via an
 * updateListener extension so callers don't have to thread a ref.
 */
export interface DiffHighlightController {
  /** Pass this to `<YamlEditor extraExtensions={ctrl.extensions}>`. */
  extensions: Extension[]
  /** Flash the given 1-indexed lines. No-op when the view hasn't mounted yet. */
  flash: (lines: number[]) => void
}

/**
 * Build a diff-highlight controller. Kept as a factory (not a global) so
 * multiple editor instances can coexist without stepping on each other's
 * epoch counters.
 */
export function createDiffHighlightController(): DiffHighlightController {
  let epochCounter = 0
  // Captured on first update. `updateListener` fires on every editor update
  // including the initial mount, so the ref is populated within microtask
  // latency of the extension being installed.
  let viewRef: EditorView | null = null
  const captureView = EditorView.updateListener.of((update) => {
    if (!viewRef) viewRef = update.view
  })

  return {
    extensions: [diffField, styleInjector, captureView],
    flash(lines) {
      if (lines.length === 0 || !viewRef) return
      const view = viewRef
      const epoch = ++epochCounter

      // Scroll the first changed line into view before dispatching the
      // decoration. Without this, CodeMirror's virtualisation leaves the
      // target line un-rendered whenever it's outside the current viewport,
      // and the line decoration's class attribute has no DOM node to attach
      // to — the flash silently no-ops. The scroll also serves as a useful
      // affordance: the user's eye gets pointed at what changed.
      const doc = view.state.doc
      const firstLine = Math.max(1, Math.min(doc.lines, lines[0]))
      const scrollTarget = doc.line(firstLine).from
      view.dispatch({
        effects: [
          flashLinesEffect.of({ lines, epoch }),
          EditorView.scrollIntoView(scrollTarget, { y: 'center' }),
        ],
      })

      // Match the CSS animation duration so the decoration removal lands
      // right as the fade completes. 100ms slack prevents late-scheduled
      // paints from clipping the last frame.
      window.setTimeout(() => {
        view.dispatch({ effects: clearEpochEffect.of(epoch) })
      }, 1300)
    },
  }
}
