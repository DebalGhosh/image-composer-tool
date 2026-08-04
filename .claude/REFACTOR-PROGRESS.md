# Refactor progress and handoff — front end DONE, back end in progress

**Read this first; it is written to be the only context you need to resume.**

Two tracks. The **front end is finished and shipped** (`0092aa6c`, allowlist at 12
by your decision — do not reopen). The **back end is mid-BE-0**: coverage
groundwork before decomposition, scoped by you to backend packages only. Jump to
"The back-end track" for the live work; everything above it is reference for the
completed front-end effort.

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

## ✅ SHIPPED — commit `0092aa6c`

The work is committed and pushed. `main == origin/main` on the fork
(`DebalGhosh/image-composer-tool`); `upstream` (`open-edge-platform`) is untouched
and the commit is confirmed not to be on it.

- **`0092aa6c`** `refactor(web): decompose the four god components into features/`
- Signed and verified: `%G? = G`, key `296E4AE6E1D23544`
- 195 files, +21,278 / −7,504

GPG signing initially failed with `Inappropriate ioctl for device` — the key was
valid but its passphrase was not cached, and gpg cannot prompt from a
non-interactive shell. Fixed by unlocking it once in a real terminal
(`export GPG_TTY=$(tty)` then any `gpg --clearsign`); signing then worked from the
agent's shell too. **If this recurs after a reboot, that is the remedy — never
`--no-verify`.**

The scratch branch `refactor/frontend-decomposition` was fast-forwarded into `main`
and deleted. `/tmp/commitmsg.txt` is not needed any more, but the full message is
still reproduced at the end of this file for reference.

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

### On the CSS baseline (corrected 2026-08-04)

`/tmp/fe2/css-baseline-542.txt` **survived the reboot** and was re-verified against
a fresh build from `0092aa6c`: 542 selectors, 41,728 B, content hash
`index-C7ZYkEzU.css` — an exact match, including the hash. It is trustworthy.

The earlier warning in this file said "`/tmp` was wiped; do not rebuild from HEAD,
HEAD emits 533". Both halves are now obsolete: the file is present, **and** HEAD is
the refactor commit, so rebuilding from HEAD would give 542 anyway. The 533 figure
belonged to the pre-refactor HEAD when the work was still uncommitted.

If it ever does need rebuilding, build into a **scratch dir**
(`npx vite build --outDir /tmp/verify-dist --emptyOutDir`) so neither `dist/` nor
the baseline is overwritten while comparing. Do **not** `git stash` to get a
"clean" tree for this — I tried that once, and it reverted the whole uncommitted
refactor (recovered with `stash pop`, nothing lost).

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
- ~~`internal/pkgsvc/handler` has zero tests.~~ **Fixed in BE-0** — 0% → **94.5%**
  across `search_test.go` and `search_routes_test.go`.

---

## Also pending, unrelated to the refactor

- ~~**Rebuild + restart the `:8083` backend**~~ — **DONE 2026-08-04.** The reboot
  had killed it outright (no listener, no process, no binary), so this was "build
  and start", not "rebuild to pick up the scraper". Verified: the scraper is
  compiled into the running binary, its tests pass, and the binary (Aug 4 08:31)
  is newer than the scraper source (Aug 2 22:25) — the exact inversion that caused
  the empty-ARTIFACTS symptom. `/api/v1/manifest` answers 200 and `:5176` proxies
  to it.

  ⚠️ **The artifact path itself is still unverified end-to-end.** The build tracker
  is in-memory, so the reboot cleared it — `/api/v1/builds/<id>/details` 404s for
  every historical build and there is nothing to query. It can only be confirmed on
  the next real dispatch. Do not record it as verified before then.

  To start it: `go build -o /tmp/ict-serve ./cmd/image-composer-tool`, then
  `set -a; . /home/debalgho/ICTT/.env.jenkins; set +a` and
  `/tmp/ict-serve serve --port 8083`. The `--port` flag defaults to **8080**
  (`cmd/image-composer-tool/serve.go:59`), so 8083 must be passed explicitly. The
  env file (mode 600) supplies `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN`;
  **never echo, log, or commit their values.**
- Tasks #9, #10 (pkgsvc crawler enablement, sub-minimum query affordance) and
  #22–#25 (pane collapse, density tokens, remaining responsive fixes).
- `internal/pkgsvc/index/zz_fp_test.go` is an untracked debug probe of mine
  (`dirExists` always returns `true`). **Excluded from the commit on purpose** —
  delete it or keep it local.

---

## The back-end track — BE-0 in progress (updated 2026-08-04)

**Scope narrowed by you: BACKEND ONLY.** `internal/api`, `internal/pkgsvc`,
`internal/webui`. The CLI (`cmd/`), the image/build engine
(`internal/image`, `internal/ospackage`, …) and the GitHub workflows are out of
scope. That reframing matters: the backend is **1,792 statements**, the smallest
of the three groups, while the aggregate gate is dominated by an 18,064-statement
image engine nobody asked about.

### BE-0: coverage before decomposition — three commits so far

Rationale: the gate was already failing before any refactor, and a decomposition
that moves untested code can only lose ground. Testing first also makes the
decomposition *possible* — `runJenkinsBuild` is a sequence of calls to the eight
HTTP round-trips, so it was unsplittable until those were pinned.

| Commit | What | Backend |
|---|---|---|
| `ddaf77cf` | `internal/api` pure helpers + 2 gate-script bugs | 45.5% → 49.1% |
| `822ebf25` | `pkgsvc/{schema,state,handler}` from 0% | → 52.3% |
| `2dbcf746` | the 8 Jenkins HTTP round-trips, 0% → 80-100% | → **58.9%** |

**Backend now 58.9%. 180 statements short of 69%.**

Remaining, worst first: `pkgsvc/crawler` 283 uncovered (29.2%) · `internal/api`
309 (mostly `handleJenkinsDispatch` + `runJenkinsBuild` itself, both now testable
because their constituents are pinned) · `pkgsvc/handler` 52 · `pkgsvc/index` 38 ·
`pkgsvc/seed` 37 at 0% · `pkgsvc/state` 11 · `internal/webui` 6 at 0%.

### ⚠️ The threshold is NOT what the script says

`run_coverage_tests.sh`'s own default is **64.2**, which the tree passes. CI reads
`.coverage-threshold` (**69.0**) and passes it in — so 69.0 is the real bar. Run
the gate as `bash scripts/run_coverage_tests.sh 69.0` to see what CI sees.

The shortfall is **pre-existing**: the front-end refactor touched zero `.go` files.

### Two gate-script bugs fixed in `ddaf77cf`

It enumerated directories with `find`, excluding only `vendor` and `.git`:
- **`node_modules`** — a third-party npm package ships a Go file (160 statements,
  no tests) counted as project code. Gitignored, untracked, unfixable here.
- **`.claude/worktrees`** — a registered git worktree holding a **second full copy
  of this repo at an older commit**. 83 phantom directories, every test binary
  built twice from two commits, and "unknown test failure" for packages that pass
  fine. The gate output was unreadable.

### ⚠️ THE MUTATION HARNESS — read before mutation-testing anything

A mutation that silently **no-ops is indistinguishable from one that survives**.
This bit twice: Go source containing `&&` passed through `python3 -c` inside a bash
pipeline gets its escaping mangled, so the replacement never applies.

Use `/tmp/mutate.py` (recreate it if `/tmp` was wiped — it is 20 lines): it takes
the target via heredoc, asserts the string is present **exactly once**, and exits
nonzero otherwise. Also pass **`-timeout 40s`**: some mutations (e.g. deleting
`waitForBuild`'s cancelled-check) make the code loop forever, and a hang is not a
result.

Across the three commits: 15 + 23 + 15 mutations, all eventually caught — but
three were only caught after fixing real gaps the exercise exposed in my own
tests.

### Latent defects found while testing — RECORDED, NOT FIXED

A test-coverage commit must not carry behaviour changes.
- **Nil-index asymmetry.** `handleHealth`/`handleReadyz` guard `s.Idx != nil`;
  `handleSearch`/`handlePackage`/`handleSuggest` do not, and `index.Get` guards its
  inner field but not a nil receiver. Unreachable today — `cmd/ict-pkgsvc/main.go`
  dereferences `idx` before the server is used, so a nil index already crashes at
  startup.
- **`trigger`'s `http.StatusFound` branch is dead code.** `http.Client`'s default
  policy FOLLOWS a 302, so `trigger` never observes one. Proven in
  `TestTriggerNeverObservesA302`. Invert that test if a `CheckRedirect` is added.
- **`Store.Get` shares the `Extra` map** — `Shard` is copied by value but the map
  is shallow, so a caller writing into it mutates the store.
- **⚠️ `/search` PAGING IS BROKEN — the most serious find of BE-0.**
  `index.Search` asks Bleve for `Limit*4` hits **starting at `Offset`**, then
  re-sorts *that window* locally (popularity tiebreak + DocID) and truncates to
  `Limit`. The local ordering is therefore computed over a window that itself slid,
  so page boundaries cannot line up. Measured on 8 equal-scoring records:

  | limit | records ever reachable | pages that overlap |
  |-------|------------------------|--------------------|
  | 1     | 5 of 8                 | one record repeats across 4 consecutive pages |
  | 2     | **3 of 8**             | 2 duplicated |
  | 4     | 5 of 8                 | 3 duplicated |

  **Reachable from the public API.** `internal/api/handlers_packages.go`'s proxy
  Director preserves the caller's query string, so `offset` passes through from
  `/api/v1/packages` to `/search` unchanged. It has not bitten because the current
  UI never sends it — `PackageSearchCombobox` fetches a single page.

  **The fix** (its own commit): request `Offset+Limit*4` from Bleve starting at **0**,
  sort, *then* slice `[Offset : Offset+Limit]`. That makes the local ordering total
  rather than per-window, which is the property paging requires.

  Characterised — not asserted-as-desired — by
  `TestSearchOffsetIsAcceptedAndShiftsTheWindow`, which pins only what is currently
  true: the param is accepted, reaches the index, and an offset past the end yields
  an empty page rather than wrapping. **Replace that test when fixing.**

### Still true of the wider Go tree (out of the narrowed scope)

- **213 functions** exceed the repo's own 50-line limit (the plan said 219);
  `imageos.go` is 2,452 lines. Worst: `rpmutils/ParseRepositoryMetadata` at **326**.
- Forbidden by repo convention: functional options (there are **zero** `func
  With*`), new singletons, any abstraction with one caller.
- `internal/api/api_test.go` has a pre-existing `gofmt` violation — not mine, left
  for its own change.

### GPG

`git commit -S` fails with `Inappropriate ioctl for device` once the agent's cache
lapses. There is **no `~/.gnupg/gpg-agent.conf`**, so gpg's 600-second idle default
applies and it recurs every few commits. Remedy: unlock once in a real terminal
(`echo test | gpg --clearsign --local-user 296E4AE6E1D23544 >/dev/null`), or add
`default-cache-ttl 28800` / `max-cache-ttl 28800` to that file and
`gpgconf --kill gpg-agent`. **Never `--no-verify`.**

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
