import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createDiffHighlightController } from './yamlDiffHighlight'

/**
 * Tests for the decoration STATE MACHINE, driven through a real EditorView.
 *
 * These exist because FE-7e decomposed `diffField.update` (complexity 17) into
 * remapThroughDocChange / applyFlash / clearEpoch, and that rewrite touched how
 * the parallel `epochByPos` map is built. Reasoning about equivalence was not
 * enough: the map is what makes a flash CLEARABLE, and getting it wrong leaves
 * lines permanently highlighted — a bug you would only ever catch by eye, on a
 * page an operator stares at for minutes at a time.
 *
 * The three properties worth pinning:
 *   - a flash attaches the class to exactly the requested lines;
 *   - the fade timer clears only ITS OWN epoch, not a concurrent flash's;
 *   - decorations follow their lines through a document edit, and stay
 *     clearable afterwards.
 *
 * ⚠️ FAKE TIMERS ARE SCOPED TO setTimeout/clearTimeout ONLY, and must be
 * installed BEFORE the view mounts. CodeMirror schedules DOM measurement via
 * requestAnimationFrame during construction and on every update; faking the
 * whole clock makes `textRange(...).getClientRects` blow up mid-measure. The
 * only timer under test is the controller's own 1300ms fade, so faking exactly
 * that pair is both sufficient and the narrowest possible intervention.
 */

beforeAll(() => {
  // CodeMirror observes its scroller. jsdom has no ResizeObserver; the class
  // never fires in a headless run, so a no-op is sufficient and honest.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const views: EditorView[] = []
afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/**
 * Mount a view and force one update so the controller captures it.
 *
 * ⚠️ THE NUDGE IS NECESSARY AND IT DOCUMENTS A REAL SUBTLETY. The controller
 * captures its EditorView from an `updateListener`, and that listener does NOT
 * run during construction — it first fires on the next transaction. Until then
 * `flash()` sees a null viewRef and silently returns. The module comment claims
 * the listener "fires on every editor update including the initial mount"; that
 * is not what happens here.
 *
 * In the app this is invisible: the parent hands YamlEditor a fresh `value` on
 * every draft change, so a transaction always precedes the first flash. It is
 * pinned as its own test below rather than papered over.
 */
function mount(doc: string) {
  const ctrl = createDiffHighlightController()
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: ctrl.extensions }),
    parent,
  })
  views.push(view)
  // A selection-only transaction: no doc change, so it cannot perturb anything
  // the tests below assert on.
  view.dispatch({ selection: { anchor: 0 } })
  return { ctrl, view, parent }
}

/** Every flash decoration in the field, in position order. */
function flashes(view: EditorView): { line: number; epoch: number }[] {
  const out: { line: number; epoch: number }[] = []
  for (const source of view.state.facet(EditorView.decorations)) {
    // The field provides a RangeSet directly, not a view-taking function.
    const set = typeof source === 'function' ? source(view) : source
    const iter = set.iter()
    while (iter.value) {
      const attrs = (iter.value.spec as { attributes?: Record<string, string> })
        .attributes
      if (attrs?.class === 'yaml-line-flash') {
        out.push({
          line: view.state.doc.lineAt(iter.from).number,
          epoch: Number(attrs['data-flash-epoch']),
        })
      }
      iter.next()
    }
  }
  return out
}

/** 1-indexed line numbers currently carrying the flash class, ascending. */
function flashedLines(view: EditorView): number[] {
  return flashes(view)
    .map((f) => f.line)
    .sort((a, b) => a - b)
}

/** The epoch stamped on each flashed decoration, in position order. */
function flashedEpochs(view: EditorView): number[] {
  return flashes(view).map((f) => f.epoch)
}

describe('the diff-highlight controller', () => {
  it('decorates exactly the requested lines', () => {
    const { ctrl, view } = mount('one\ntwo\nthree\nfour')
    ctrl.flash([2, 4])
    expect(flashedLines(view)).toEqual([2, 4])
  })

  it('is a no-op for an empty line list', () => {
    const { ctrl, view } = mount('one\ntwo')
    ctrl.flash([])
    expect(flashedLines(view)).toEqual([])
  })

  it('SKIPS out-of-range line numbers instead of throwing', () => {
    // doc.line() throws out of range. The differ runs against a string the
    // editor may not have applied yet, so a stale number is possible.
    const { ctrl, view } = mount('one\ntwo')
    expect(() => ctrl.flash([0, 1, 99, -5])).not.toThrow()
    expect(flashedLines(view)).toEqual([1])
  })

  it('stamps a fresh, increasing epoch on each flash', () => {
    const { ctrl, view } = mount('a\nb\nc\nd')
    ctrl.flash([1])
    ctrl.flash([3])
    const epochs = flashedEpochs(view)
    expect(epochs).toHaveLength(2)
    expect(new Set(epochs).size).toBe(2)
    expect(Math.max(...epochs)).toBeGreaterThan(Math.min(...epochs))
  })

  it('does NOT stack two decorations on one line — the later flash supersedes', () => {
    // CodeMirror permits two decorations at a position, but the second's
    // `animation` restarts the first's, so a line edited twice would stutter.
    const { ctrl, view } = mount('a\nb\nc')
    ctrl.flash([2])
    const firstEpoch = flashedEpochs(view)[0]
    ctrl.flash([2])
    const after = flashedEpochs(view)
    expect(after).toHaveLength(1)
    expect(after[0]).not.toBe(firstEpoch)
    expect(flashedLines(view)).toEqual([2])
  })

  describe('the fade timer', () => {
    it('clears the decoration when it fires', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { ctrl, view } = mount('a\nb\nc')
      ctrl.flash([2])
      expect(flashedLines(view)).toEqual([2])
      vi.advanceTimersByTime(1300)
      expect(flashedLines(view)).toEqual([])
    })

    it('has not cleared before its 1300ms deadline', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { ctrl, view } = mount('a\nb\nc')
      ctrl.flash([2])
      vi.advanceTimersByTime(1299)
      expect(flashedLines(view)).toEqual([2])
    })

    it('clears ONLY its own epoch, leaving a concurrent flash alone', () => {
      // The reason epochs exist at all. Two dispatches 500ms apart: when the
      // first timer fires, the second flash must survive.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { ctrl, view } = mount('a\nb\nc\nd\ne')
      ctrl.flash([1])
      vi.advanceTimersByTime(500)
      ctrl.flash([4])
      expect(flashedLines(view)).toEqual([1, 4])

      vi.advanceTimersByTime(800) // t=1300: first epoch's timer
      expect(flashedLines(view)).toEqual([4])

      vi.advanceTimersByTime(500) // t=1800: second epoch's timer
      expect(flashedLines(view)).toEqual([])
    })
  })

  describe('surviving a document edit', () => {
    it('follows its line when text is inserted ABOVE it', () => {
      const { ctrl, view } = mount('a\nb\nc')
      ctrl.flash([3]) // 'c'
      expect(flashedLines(view)).toEqual([3])
      // Insert a whole new line at the very start.
      view.dispatch({ changes: { from: 0, insert: 'zero\n' } })
      // 'c' is now line 4 and the decoration moved with it.
      expect(view.state.doc.line(4).text).toBe('c')
      expect(flashedLines(view)).toEqual([4])
    })

    it('STAYS CLEARABLE after the edit — the epoch followed the decoration', () => {
      // This is the regression the FE-7e rewrite could have introduced. If
      // remapThroughDocChange fails to carry the epoch across, the timer's
      // clearEpoch finds nothing to drop and the line stays lit forever.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { ctrl, view } = mount('a\nb\nc')
      ctrl.flash([3])
      view.dispatch({ changes: { from: 0, insert: 'zero\n' } })
      expect(flashedLines(view)).toEqual([4])
      vi.advanceTimersByTime(1300)
      expect(flashedLines(view)).toEqual([])
    })

    it('keeps a flash on an unaffected line when text below it changes', () => {
      const { ctrl, view } = mount('a\nb\nc')
      ctrl.flash([1])
      const end = view.state.doc.length
      view.dispatch({ changes: { from: end, insert: '\nd' } })
      expect(flashedLines(view)).toEqual([1])
    })
  })

  it('injects its stylesheet exactly once, however many views mount', () => {
    // A single idempotent <style> tag, deliberately not EditorView.baseTheme:
    // baseTheme prepends .cm-editor to every top-level rule, which silently
    // breaks the @keyframes block.
    mount('a')
    mount('b')
    const tags = document.querySelectorAll('#yaml-diff-highlight-style')
    expect(tags).toHaveLength(1)
    expect(tags[0].textContent).toContain('yaml-line-flash-anim')
  })

  it('accepts line numbers in ANY order — RangeSetBuilder needs them ascending', () => {
    // Defensive, and knowingly so: diffChangedLines always emits ascending, and
    // toItems() reads an already-ordered RangeSet, so nothing in the app feeds
    // this out of order today. fromItems() sorts anyway because
    // RangeSetBuilder.add() THROWS on a non-monotonic position, which would
    // take down the whole editor rather than degrading one flash. Pinned so the
    // sort is not deleted as dead code.
    const { ctrl, view } = mount('a\nb\nc\nd\ne')
    expect(() => ctrl.flash([5, 3, 1])).not.toThrow()
    expect(flashedLines(view)).toEqual([1, 3, 5])
  })

  it('flashes NOTHING before the view has been captured', () => {
    // Documents the updateListener capture window: `flash()` returns early
    // while viewRef is null, which is every moment before the first
    // transaction. Constructed here WITHOUT the mount() helper's nudge.
    const ctrl = createDiffHighlightController()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({ doc: 'a\nb', extensions: ctrl.extensions }),
      parent,
    })
    views.push(view)
    ctrl.flash([1])
    expect(flashedLines(view)).toEqual([])
    // One transaction later, the same call lands.
    view.dispatch({ selection: { anchor: 0 } })
    ctrl.flash([1])
    expect(flashedLines(view)).toEqual([1])
  })

  it('gives each controller its own epoch counter', () => {
    // Kept a factory, not a global, so two editors cannot clear each other's
    // decorations by epoch collision.
    const first = mount('a\nb')
    const second = mount('c\nd')
    first.ctrl.flash([1])
    second.ctrl.flash([1])
    expect(flashedEpochs(first.view)).toEqual(flashedEpochs(second.view))
    // Same epoch number, but separate fields — clearing one leaves the other.
    expect(flashedLines(first.view)).toEqual([1])
    expect(flashedLines(second.view)).toEqual([1])
  })
})
