# UI layout — why viewport breakpoints are wrong here

> Read this before adding any `sm:` / `md:` / `lg:` / `xl:` class to
> `web/src/components/`, before putting `@container` on an element, or before
> touching `--header-h` and the density tokens in `web/src/index.css`.
>
> The short version: **almost nothing in this app should respond to the
> viewport**, and the one CSS property that makes container queries work also
> silently breaks `position: fixed` and z-index layering.

Everything below was checked against source. Line references are to the state
at commit `868eae79`.

---

## 1. The reference-frame bug

Tailwind's `sm:`/`md:`/`lg:`/`xl:` variants measure the **viewport**. But nearly
all content lives inside `react-resizable-panels` panes whose width is
`viewportWidth x userDraggedFraction` — and `BuildImagePage.tsx:160` persists
that fraction to `localStorage` via `autoSaveId`. So a viewport breakpoint fires
on a box whose width it never saw.

This is not merely imprecise. It is **inverted** over part of its range.
InteractivePage's two-column grid, inside the left pane:

| Viewport | `md:` state | Width per column |
|---|---|---|
| 1024px | **on** (2 cols) | **229px** |
| 767px | off (1 col) | **334px** |

The grid is *tightest immediately before the breakpoint disengages*. Adding
breakpoints made the cramped case worse, which is why "just add responsive
classes" was the wrong fix.

Same query, two opposite correct answers: `md:` fires at a 1920px viewport where
the content box is 968px (right call) **and** at 1024px where it is 475px (wrong
call). One threshold cannot serve both.

The codebase already knew this. `BasicPage.tsx` declines a two-column summary
variant with exactly this reasoning. Seven other sites violated it and have now
been converted.

## 2. The split that replaces it

| Concern | Primitive | Why |
|---|---|---|
| Anything inside a pane | **container query** (`@max-pane-*`) | immune to drag position and to the persisted split |
| Header, toasts, shell height, dropdown max-heights | **viewport** media query | these genuinely span the window |
| Density (padding) | **`@media (max-height:)`** + custom properties | what runs out at 1366x768 is vertical room |
| Pane auto-collapse | **`ResizeObserver`** | needs the pane's px width to drive the imperative `resize()` API |

Container queries are written **wide-as-base, subtracting columns** (`@max-*:`,
not mobile-first `@min-*:`). There is no supported viewport below 1280, so a
missing marker or an unsupported engine degrades to the wide layout — which is
what every shipping monitor wants. Mobile-first would degrade to a phone layout
on a desktop.

The thresholds live in `@theme` in `index.css` and are **not** emitted as CSS
custom properties — Tailwind v4 inlines them into the query condition, so you
will not find `--container-pane-2col` in the built CSS. What ships is:

    @max-pane-2col:  ->  @container not (min-width: 34rem)
    @min-pane-4col:  ->  @container (min-width: 50rem)

(the `@max-*` form is negated rather than written `width < 34rem`, which is why
grepping the bundle for `width <` finds nothing)

Currently in use (grep before inventing a new one):
`@max-pane-2col:grid-cols-1`, `@max-pane-2col:col-span-1`, `@max-pane-2col:w-20`,
`@max-pane-4col:grid-cols-1`, `@max-pane-4col:grid-cols-2`,
`@min-pane-2col:inline-block`, `@min-pane-4col:w-10`.

## 3. ⚠️ `container-type` creates a stacking context — the trap

**This is the one thing in this document most likely to cost someone a day.**

`container-type: inline-size` implies `contain: layout inline-size`. Layout
containment does two things, and the second is easy to miss:

1. It makes the element **a containing block for `position: fixed`** descendants.
2. It **creates a stacking context**, which is painted as one atomic unit in the
   normal-flow layer.

Consequence of (2): put `@container` on a Card body and an open Combobox dropdown
(`Combobox.tsx:249`, `z-30`) is painted *inside* that unit. The next sibling
`<Card>` paints its opaque `--section-background` over it. **The dropdown
disappears.** `z-30` does not save you — it only orders siblings *within* the new
context.

Every Interactive card sits directly above another card, and both partition-row
grids hold Comboboxes. A per-card placement would have shipped that bug.

**So: one `@container` per PANE, high in the tree. Never on a card, never on a
row.** One container per pane keeps every card and every dropdown in the same
stacking context, leaving internal layering provably unchanged. Current markers:

- `InteractivePage.tsx:561` — left pane scroll container
- `BasicPage.tsx:415` — form pane
- `BuildView.tsx:327` — build detail column

Consequence of (1): **`AdvancedPage` deliberately has no `@container`.** Its
`YamlEditor` sits in the scrolling flow inside a `<Card>`, and the editor's
fullscreen is an in-tree `position: fixed; zIndex: 60` wrapper
(`YamlEditor.tsx:515`) — there are **zero `createPortal` calls in the codebase**.
Any container ancestor would trap that overlay inside the Card instead of
covering the viewport. The pages that *do* have markers are safe only because
their YAML surfaces live in the *other* pane or mount from `DialogOverlay`
outside the `PanelGroup`.

Three related checks, all confirmed, so don't re-litigate them:

- Layout containment does **not** clip — that is `contain: paint`. `Card.tsx:313`'s
  deliberate `overflow: visible` release still lets dropdowns spill.
- It does **not** break `position: sticky`, which needs a *scroll* ancestor. That
  is still the pane's `overflow-y-auto`, so `Card.tsx:228-233` holds.
- Native `requestFullscreen` (the build-log terminal) promotes to the browser top
  layer and is unaffected by containment.

z-index inventory, for anything that has to layer: `Card.tsx:265` `z-20` (sticky
header), `Combobox.tsx:249` / `MultiCombobox.tsx:331` `z-30`, `Header.tsx:75`
`z-40`, `toast/ToastContainer.tsx:17` `z-50`, `YamlEditor.tsx:515` `60`,
`DialogOverlay.tsx:368` `100`.

## 4. ⚠️ Tailwind v4 scans comment text

Tailwind v4 scans raw file **text**, with no notion of JS syntax. Writing a class
name inside an explanatory comment **generates that utility**.

This actually happened: after removing the viewport variants, the emitted CSS
still contained `.md\:grid-cols-2`, `.lg\:grid-cols-4` and `.xl\:grid-cols-2` —
resurrected purely by comments *explaining what had just been removed*. Three
comments had to be reworded to spell breakpoints out in prose.

When documenting a class you removed, describe it in words. Verify with:

    cd web && npm run build
    grep -c 'md.:grid-cols' dist/assets/*.css   # must be 0

Use `.` for the escape character rather than trying to quote a literal
backslash — Tailwind emits the class selector as `.md\:grid-cols-2`, and getting
`\\` through both the shell and grep is its own small trap that silently reports
0 matches whether or not the class is there.

There is **no `tailwind.config.js`** — v4 is configured entirely in CSS via
`@theme` in `index.css`. Breakpoints are never overridden, so the defaults apply
(sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536).

## 5. `--header-h` is measured, and four shells depend on it

`--header-h: 57px` (`index.css:122`) is measured, not guessed: Header's `py-3`
(12+12) + its tallest child (`ThemeToggle` `h-8` = 32px; the `h-7` logo and
`text-lg` title are both shorter) + `border-b` 1px.

Four page shells previously hardcoded `3.75rem` (60px) — a 3px dead strip on
every tab. They now share `.page-shell` (`index.css:269`), which is also where
the `.action-footer` and `.resize-handle` rules went after being duplicated
verbatim in four inline `<style>` blocks.

Two consequences:

1. **A header that word-wraps to two lines breaks all four pages at once** — it
   would go 57 -> ~89px, every `calc()` shell overshoots, the document starts
   scrolling and every action footer drops below the fold. This is why the brand
   wrapper, nav and right cluster are all `shrink-0`, the title is
   `whitespace-nowrap`, and the verbose tab labels collapse to `sr-only` below
   1440px (`sr-only`, not `hidden`, so screen readers still announce them).
2. `Header.tsx:127`'s `-bottom-[13px]` tab underline encodes the same `py-3` +
   `border-b` numbers a fifth time. It measures from the *nav's* own box so it
   survived the refactor, but **changing `py-3` or the toggle's `h-8` means
   re-measuring both**.

## 6. Density tokens — declared, mostly not yet consumed

`index.css:132-137` declares `--pad-page`, `--pad-card`, `--pad-card-y`,
`--pad-footer-y`, `--h1-size`, `--term-min-h`, re-pointed by a single
`@media (max-height: 800px)` block (`:152`).

**State of play: only `--term-min-h` (`BuildView.tsx:722`) and `--header-h`
(`index.css:270`) are actually consumed.** The four padding tokens and
`--h1-size` are live declarations with **zero call sites** — the compact tier is
therefore largely inert. Wiring them up is pending work, not a finished feature;
see §8.

Design notes worth keeping:

- **Height-keyed, not width-keyed.** A 1280-wide window on a 1080-tall monitor is
  not cramped. 800px is the cut so 1280x720 and 1366x768 get compact spacing
  while 1440x900 and 1920x1080 keep the roomy defaults. Known consequence: a
  short-but-wide display (2560x800) also gets the compact tier. That is intended.
- **Spacing, deliberately not type.** The type scale has no headroom left —
  `text-[11px]` appears ~28x and is already at the accessibility floor. All the
  slack on a short screen is in padding.
- Chosen over `@theme` spacing tokens (static at build time, cannot be re-pointed
  from a media query) and over parallel plain-CSS classes (hides padding from the
  JSX). When consuming `--h1-size`, the `length:` hint is required —
  `text-[length:var(--h1-size)]` — or Tailwind won't emit `font-size`.

## 7. Layout has no test coverage

`web/` has exactly **one** test file, `src/lib/draftFromYaml.fidelity.test.mjs`,
and it contains **zero** occurrences of `className` or `style`. There is **no
`lint` script**. The gates are:

    cd web && npx tsc -b
    cd web && npm run build
    cd web && npm run test:fidelity   # must stay 59/59

None of them can see a layout regression. **Layout must be verified by eye.** A
green suite after a CSS change means nothing more than "it still compiles."

The single highest-risk regression to check manually: **fullscreen Advanced's
YAML editor and confirm it covers the viewport, not the Card** (§3). Then drag
the Interactive split wide->narrow and confirm the two-column grid breaks at the
*pane* threshold rather than the window's.

## 8. Known-incomplete work

The responsive pass landed as `86bc9fff` covering the foundation only. Still
pending, and **currently on `main`**:

- **Density tokens unconsumed** (§6) — ~17 call sites, so the compact tier is
  mostly inert.
- **No pane auto-collapse.** `animatePanel` (rAF + `easeOutCubic`, cancel-in-flight
  guard, 520/380ms) exists twice — `InteractivePage.tsx:233` and
  `BuildImagePage.tsx:114` — and `InteractivePage.tsx:218` carries a standing
  `TODO(v2): dedupe with BasicPage`. **BasicPage has no chevron at all**, so its
  preview cannot be reopened manually; adding auto-collapse there needs
  Interactive's chevron ported, not merely reused.
- **Toasts paint over the header.** `toast/ToastContainer.tsx:17` is
  `fixed top-4 right-4 z-50`, and 16px is *inside* the 57px header, so every
  toast covers the ThemeToggle and BuildIndicator. `z-50` beats the header's
  `z-40`.
- Non-wrapping action footers, tables that clip rather than scroll, fixed-px
  dropdown `max-h` against a short viewport, and a percentage-based disk-bar
  label threshold that is width-blind.

Each of these has a derived threshold rather than a guessed one; where the
reasoning isn't recorded in this file it is in the commit message for
`86bc9fff`.

## Rules

1. **No new `sm:`/`md:`/`lg:`/`xl:` classes on pane content.** Use
   `@max-pane-2col:` / `@max-pane-4col:`. Viewport variants are correct *only*
   for the header, toasts and shell height.
2. **Never put `@container` on a Card, a row, or any ancestor of a
   `YamlEditor`.** One per pane. Re-read §3 before adding one anywhere.
3. **Never name a removed utility class in a comment** — Tailwind will regenerate
   it (§4).
4. **Re-measure `--header-h`** if Header's `py-3` or `ThemeToggle`'s `h-8`
   changes, and re-check `Header.tsx:127` at the same time.
5. **Verify layout by eye.** The test suite cannot (§7).
