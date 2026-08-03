# Front-end refactor — progress and handoff

**State as of the last session.** Read this first; it is written to be the only
context you need to resume.

---

## Where things stand

The front-end decomposition described in `refactor-react-go-clean-code.md` is
**complete through FE-8**, with one deliberate stopping point (below).

| Metric | Before | Now |
|---|---|---|
| ESLint size allowlist | 21 entries | **12** |
| Tests | 60 | **541** |
| Test files | ~3 | 33 |
| `web/src` non-test lines | 14,786 | ~17,400 |
| CSS selectors / bytes | 542 / 41,728 | **identical** |
| `test:fidelity` | 59/59 | **59/59** |

The line growth is doc comments carrying rationale, plus ~5,400 lines of tests.

### Scope decision you made

Asked whether to keep going past the plan, you chose **"FE-7c/7d/8 only, then
stop"**. So the allowlist lands at 12, not 0, and the remainder is *documented as
deliberately deferred* rather than silently skipped. Do not treat the non-empty
allowlist as unfinished work unless you decide to reopen scope.

---

## ⚠️ BLOCKED: the commit is staged but not committed

Everything is staged on branch **`refactor/frontend-decomposition`** (194 files,
+20,877 / −7,504). `git commit -S` **failed**:

```
gpg: signing failed: Inappropriate ioctl for device
```

The key `296E4AE6E1D23544` exists and is valid, but its passphrase is not cached
and gpg cannot prompt from the agent's non-interactive shell. The repo config has
`commit.gpgsign=true` and the standing instruction is **never bypass signing** —
so this needs a human.

**To unblock, run in your own terminal:**

```bash
cd /home/debalgho/ICTT/image-composer-tool
echo test | gpg --clearsign --local-user 296E4AE6E1D23544 > /dev/null   # enter passphrase
git commit -S -F /tmp/commitmsg.txt     # message is already written
git push -u origin refactor/frontend-decomposition
```

`/tmp/commitmsg.txt` may be gone after a reboot — the full message is reproduced
at the end of this file.

**Push target, confirmed with you mid-session: `origin` (the
`DebalGhosh/image-composer-tool` fork), branch `main` is the eventual
destination.** Never push to `upstream` (`open-edge-platform`). The work is on a
branch rather than committed straight to `main` per the repo convention; merge or
fast-forward into the fork's `main` as you prefer.

---

## The measure of done, and the one honest way to check it

**The allowlist in `web/eslint.config.js` is the progress metric**, not line
counts. An entry may be removed only after **stripping the entire allowlist block
and re-running `eslint`**. Running `eslint <one file>` while its entry is still
present tells you nothing: the entry silences the very rule you are testing for.
I got this wrong once early on and had to restore three entries.

```bash
# the honest check
cd web && cp eslint.config.js /tmp/es.bak
python3 -c "
p='eslint.config.js'; s=open(p).read()
i=s.index('  {\n    /* ---'); j=s.index(\"      complexity: 'off',\n    },\n  },\n\",i)+len(\"      complexity: 'off',\n    },\n  },\n\")
open(p,'w').write(s[:i]+s[j:])"
npx eslint src 2>&1 | grep 'error '
cp /tmp/es.bak eslint.config.js
```

**The pattern that governs everything here:** extracting logic and leaf
components off a god component does **not** clear its allowlist entry — only
splitting its own JSX `return` does. FE-6 proved it: pulling the four-concern SSE
effect out took BuildView 993 → 801 lines and the entry did not budge. Splitting
the return took it to 162 and cleared all three rules. Line count falls a long way
before the ratchet notices.

A corollary: the ratchets count **comment lines** (`skipComments: false`,
deliberately). When a file is close, move each block of rationale to the part
whose code it now describes — that is correct regardless of the linter. **Deleting
rationale to hit a line target is not.** Every block I moved was verified present
in its new home first.

---

## What remains on the allowlist (12)

Run the honest check above for current numbers; as of the last session:

**Never scheduled — fenced by design**
- `src/lib/draftFromYaml.ts` — complexity 41, 797 lines. `.claude/YAML-INTEGRITY.md`
  fences it. Its entry is **permanent**. Do not restructure it to hit a target.

**Reduced but not cleared** (FE-4 / FE-5 stopped short)
- `src/features/package-search/PackageSearchDialog.tsx` — 726 lines, fn 655
- `src/features/compose-interactive/InteractivePage.tsx` — 987, fn 881
- Both had their logic and leaf components extracted; both still have one huge
  JSX return. That is exactly the pattern above.

**Never in the front-end plan** — 7 primitives in `components/`
- `Combobox` (complexity 24, fn 284) · `MultiCombobox` (16 / 536 / 397) ·
  `Slider` (fn 154) · `BuildProgress` (complexity 27) · `Card` (25 / 221) ·
  `DialogOverlay` (564 / 391) · `PackageSearchCombobox` (fn 158)
- The plan says these get trimmed "opportunistically as their feature phase
  touches them". No remaining phase touches them, so on the current plan they
  keep their entries indefinitely.

**Monitor, partially done**
- `BuildHistoryList.tsx` (405 / 191) · `BuildImagePage.tsx` (fn 186) — FE-6
  covered `BuildView` only.

---

## The guardrails — traps no gate can see

These have all bitten during this work. Re-read before touching JSX or comments.

1. **`@container` must stay at exactly 3**, one per pane: InteractivePage,
   BasicPage, BuildView. `container-type: inline-size` implies `contain: layout`,
   which creates a containing block for `position: fixed` **and** a stacking
   context painted atomically. This app has **zero React portals**, so every
   overlay is in-tree — a new marker traps the YamlEditor's fullscreen overlay
   inside a Card, and hides Combobox dropdowns (z-30) behind the next Card.
   `z-index` does not save you. **AdvancedPage must gain none.**

2. **Tailwind v4 scans raw file TEXT, including comments.** Naming a utility
   class in prose *generates that utility*. This happened **three times** in this
   effort — `.md\:grid-cols-2` (before my involvement), `.invert`, and `.z-60`,
   the last two from comments I wrote. Two of my own guardrail comments broke the
   guardrails they described: writing "there are 0 createPortal calls" made the
   `createPortal` trap grep report a false positive on itself. **Check the built
   CSS after every phase**, and phrase constraints without naming the token.

3. **`test:fidelity` must stay 59/59.** Before the original fix, 46 of 59
   templates were altered and **zero** round-tripped byte-identical; two builds
   went green publishing images that did not match their templates.

4. **`PERSIST_VERSION = 2` has no `migrate()`.** Zustand *discards* mismatched
   state — that is intended. So renaming or restructuring any persisted field
   requires bumping it, and changing a field's shape *without* bumping is worse:
   it rehydrates the wrong shape. Keys that must not change: `ict.store`,
   `ict.theme` (**hand-duplicated in `web/index.html`'s anti-FOUC script — change
   both or neither**), `ict.buildHistory.v1`, `ict.packagesearch.recents`, and
   `autoSaveId` on the PanelGroups. FE-7b split `store.ts` but deliberately did
   **not** split it into four Zustand stores: `partialize` names five fields
   persisted together under one key, and four keys would lose every live draft.

5. **Do not add a router.** `App.tsx` mounts all four pages simultaneously behind
   `hidden={view !== …}`. Load-bearing twice: InteractivePage's Cmd+K guard reads
   `offsetParent === null` to detect its own page is hidden (only true inside a
   `display: none` subtree), and each page's local state survives a tab switch
   only because nothing unmounts.

6. **Move inline styles with their JSX.** A component that leaves its style
   object behind loses all theming **silently, in both themes**, and `tsc` will
   not notice. Census guard: **275** `style={{` objects, **28** distinct
   `var(--…)` tokens.

7. **Carry every `eslint-disable` with its comment.** There are **8**. Two are
   load-bearing dep arrays (now in `hooks/useBuildStream.ts` and
   `hooks/useFlipReorder.ts`); two more moved into compose-basic's hooks during
   FE-7c. Never "fix" a dep array to satisfy the config.

8. **`--header-h: 57px` is measured.** Do not touch header spacing.

9. **`.claude/worktrees/` is a live registered git worktree and is NOT
   gitignored.** `git status` shows it untracked. **Stage explicit paths only —
   never `git add -A`.** I hit this: `git add web/src` also swept in six scratch
   `.mjs` probes, which is how I noticed.

10. **HMR cannot follow moved files.** After any phase that moves files, restart
    the dev server with `node_modules/.vite` cleared, or Vite serves
    `index.html` (200, `text/html`) for moved module paths and you get a white
    screen with no error. Verified by walking the module graph, not by eye.

---

## Per-phase verification (run all of it)

```bash
cd web
npx tsc -b
npm run lint                    # must be 0 ERRORS; 23 warnings are expected
npx vitest run
npm run test:fidelity           # MUST stay 59/59
rm -rf dist node_modules/.vite && npm run build

# CSS selector-set identity — the single best behaviour-preservation check
grep -o '[^{}]*{' dist/assets/*.css | sed 's/dist\/assets\/[^:]*://; s/{$//' \
  | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sort -u > /tmp/css-now.txt
diff /tmp/css-now.txt /tmp/fe2/css-baseline-542.txt    # 542 selectors, 41,728 B

# traps
grep -rn 'className="@container' src | wc -l     # exactly 3
grep -rn 'createPortal' src | wc -l              # 0 (mind trap #2)
grep -ho 'md.:grid-cols' dist/assets/*.css | wc -l   # 0 — use `.` not a backslash
grep -rn 'eslint-disable' src --include='*.ts*' | grep -v '\.test\.' | wc -l  # 8

# census
grep -ro 'style={{' src --include='*.tsx' | grep -v '\.test\.' | wc -l        # 275
grep -ro 'var(--[a-z0-9-]*)' src --include='*.tsx' | grep -v '\.test\.' \
  | sed 's/.*://' | sort -u | wc -l                                          # 28

cd .. && go build ./...          # internal/webui embeds dist
```

⚠️ The CSS baseline lives in `/tmp`, which **the reboot wiped**. Do not rebuild it
from `HEAD` — HEAD emits **533** selectors because the chip work and everything
after it is in this uncommitted branch. Rebuild it from this branch's build
output, and note that I briefly `git stash`ed the working tree trying to do this
the wrong way (recovered with `stash pop`, nothing lost — but don't repeat it).

**Then restart the dev server and verify the module graph transforms clean**
(~147 modules, 0 problems) — `:5176`, `VITE_API_TARGET=http://localhost:8083`,
flags `--port 5176 --strictPort --host 127.0.0.1`.

---

## By-eye checks still outstanding

The suites cannot see layout. Dark mode first (the product default):

1. **Fullscreen Advanced's YAML editor — confirm it covers the viewport, not the
   Card.** The single highest-risk regression of this whole refactor.
2. Open a Combobox in the **last** Card of a pane; its dropdown must paint *over*
   the Card below.
3. Drag the Interactive split wide → narrow: the 2-col grid must break at the
   **pane** threshold, not the window's.
4. Package-search dialog: keyboard nav, Escape, focus trap, recents.
5. Add/delete/resize/reorder partitions — rows must not ghost; typing or dragging
   a slider must **not** animate rows.
6. Start a build: log streaming, stepper, fullscreen terminal, artifact links.
7. Toggle light mode across every surface touched — stranded inline styles show
   here.
8. `prefers-reduced-motion: reduce`.

---

## Testing discipline that caught real problems

**Every new suite was mutation-tested**, with sources restored byte-identical
afterwards. This found **three tests that passed while proving nothing**:

- `ArtifactTable`'s path-precedence test asserted `toContain` on *row* text; the
  URL also appears in two hrefs, so reversing `path ?? url` still passed.
- `autofill`'s "upstream wins" fixture left `platform` unset, so the downstream
  candidate's gate was closed and **any** rule order passed.
- `yamlDiffHighlight`'s ordering property was untested, so dropping a `sort()`
  that prevents a `RangeSetBuilder` throw broke nothing.

**A mutation that silently no-ops looks exactly like a passing one.** One of mine
did: the regex substitution was mangled through nested shell/Python quoting, so
"survived" meant "never applied". Re-run properly it failed 5 tests. If a
mutation survives, *verify the file actually changed* before concluding the code
is equivalent.

Two equivalences were **proved, not eyeballed**:
- BasicPage's six-branch auto-fill cascade → rule table: all **46,656**
  (selection × option-count) states, **0** divergences.
- YamlEditor's four-branch Tab trap → one rule: all 8 shift × focus states, 0
  divergences.

---

## Latent defects — recorded, deliberately NOT fixed

A refactor diff must not carry behaviour changes. Each is documented at its site.

- **`rootTypeFor('armv7hl')`** pairs `type: 'linux'` with the **amd64** UUID via
  `?? preset.typeUUID`.
- **`BuildView`'s artifact URL** is hand-built, bypassing `api/client.ts`'s
  `BASE`.
- **AdvancedPage's Platform `<Select>`** is enabled in one reachable state where
  the auto-fill cascade declines (no vertical chosen **and** no combination
  carries a SKU). Direction is safe — auto-fill is *stricter*, so it never fills a
  greyed-out field. Pinned by a test in `model/autofill.test.ts`.
- **`os={draft.target.dist}`** — prop named `os`, fed the dist.
- `patch*` helpers close over `draft`/`setDraft`, so a React-free `model/patch.ts`
  is not a straight move.
- `internal/pkgsvc/handler` has zero tests.

---

## Also pending, unrelated to the refactor

- **Rebuild + restart the `:8083` backend** so the ARTIFACTS section shows the
  published image. The running binary predates the publish-scraper commit; that
  is the whole reason artifacts looked missing. You said "we'll do it tomorrow".
- Tasks #9, #10 (pkgsvc crawler enablement, sub-minimum query affordance) and
  #22–#25 (pane collapse, density tokens, remaining responsive fixes).
- `internal/pkgsvc/index/zz_fp_test.go` is an untracked debug probe of mine
  (`dirExists` always returns `true`). **Excluded from the commit on purpose** —
  delete it or keep it local.

---

## The deferred back-end track (BE-1…BE-8)

Planned in `refactor-react-go-clean-code.md`, never started.
- **219 functions** exceed the repo's own 50-line limit; `imageos.go` is 2,452
  lines.
- The Go coverage gate is **aggregate** and auto-ratchets upward from 69.0.
- `internal/api` is only **44.2%** covered.
- Forbidden by repo convention: functional options (there are **zero** `func
  With*`), new singletons, any abstraction with one caller.

---

## The commit message (in case `/tmp` was wiped)

```
refactor(web): decompose the four god components into features/

Splits web/src into a nested feature tree and adds the safety net that was
missing when those files grew: a test runner, a linter, and size ratchets.

WHY NOW. Four components carried 5,702 lines between them — InteractivePage
(1616, one 1104-line function), SegmentedPartitionEditor (1614, ten component
definitions in one file), PackageSearchDialog (1477, nine useState), BuildView
(995, one effect holding SSE + a 5s poll + a one-shot latch + 404 handling).
Nothing enforced any limit: the package had no test runner and no linter at
all, and `strict` was unset. Those absences are why the files reached that size.

WHAT LANDED
  - Phase 0: strict: true (measured zero-error), Vitest + RTL + jsdom, ESLint 9
    flat config with max-lines 400 / max-lines-per-function 150 / complexity 15
    / max-params 5, plus a shrinking allowlist of the files that violate today.
  - FE-1..FE-2: shared types/, icons/, hooks/, an api/sse.ts Adapter, then the
    directory move behind an @/ alias (registered in BOTH tsconfig.app.json and
    vite.config.ts — with only the first, tsc passes and vite build fails).
  - FE-3..FE-7: per-feature model/ (pure, tested), hooks/, and parts/.

  Tests 60 -> 541. The allowlist shrank 21 -> 12 entries.

THE MEASURE OF DONE is the allowlist, not the line count. An entry is removed
only after stripping the whole block and re-running — running `eslint <file>`
while its entry is active silences the very rule under test. The pattern worth
recording: extracting logic and leaf components off a god component does NOT
clear its entry; only splitting its own JSX return does. Line count falls a long
way before the ratchet notices.

BEHAVIOUR IS PRESERVED, and these are the checks that establish it rather than
assert it:
  - the CSS selector set and byte size are IDENTICAL to the pre-refactor build
    (542 selectors, 41,728 B). Tailwind v4 scans comment TEXT, so a class named
    in prose generates that utility; three comments written during this work did
    exactly that and were reworded.
  - test:fidelity stays 59/59 — lib/draftFromYaml.ts is fenced and untouched.
  - the inline-style census holds at 275 objects / 28 var(--) tokens. An
    extracted component that leaves its style object behind loses all theming
    silently, in both themes, and tsc does not notice.
  - @container markers stay at exactly 3, one per pane. container-type implies
    contain: layout, which would make the marked element the containing block
    for the in-tree position:fixed fullscreen overlay and trap it inside a Card.
  - all 8 pre-existing eslint-disable comments survive with their rationale.
  - App.tsx still mounts all four pages behind hidden={view !== …}. Not an
    oversight: InteractivePage's Cmd+K guard reads offsetParent === null, and
    each page's local state survives a tab switch only because nothing unmounts.

Two equivalences were proved rather than eyeballed: BasicPage's six-branch
auto-fill cascade became a rule table, checked across all 46,656 (selection ×
option-count) states with zero divergence; and YamlEditor's four-branch Tab trap
collapsed to one rule, checked across all 8 shift × focus states.

Every new test suite was mutation-tested with sources restored byte-identical.
Three tests that passed while proving nothing were found that way and fixed.

RECORDED, NOT FIXED — pre-existing, and a refactor diff should not carry
behaviour changes:
  - AdvancedPage's Platform <Select> is enabled in one state where the auto-fill
    cascade declines (no vertical chosen and no combination carries a SKU). The
    direction is safe — auto-fill is stricter, so it never fills a greyed-out
    field — and it is pinned by a test.
  - rootTypeFor('armv7hl') pairs type: 'linux' with the amd64 UUID.
  - BuildView's artifact URL is hand-built rather than routed through
    api/client.ts's BASE.

FE-8 removes ten scratch files that were never meant to ship (six
src/lib/__probe*.mjs, four web/bench*.mjs). draftFromYaml.fidelity.test.mjs is
NOT among them — that is the fidelity gate.

Still on the allowlist: seven primitives (Combobox, MultiCombobox, Slider,
BuildProgress, Card, DialogOverlay, PackageSearchCombobox), two monitor files,
PackageSearchDialog and InteractivePage — the last two were reduced but not
cleared — and lib/draftFromYaml.ts, whose entry is permanent by design.
```
