import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * ESLint 9 flat config. This is the first linter this package has ever had —
 * which is why four components reached 1000+ lines and 40+ functions exceed
 * every stated limit. The size rules below are the ratchet that stops the files
 * re-rotting after the decomposition.
 *
 * ⚠️ Adding this file makes the 8 pre-existing `eslint-disable-next-line`
 * comments LIVE for the first time. Every one of them is deliberate and two
 * carry load-bearing rationale that a naive "fix the dep array" would break:
 *
 *   - useBuildStream.ts    depends only on [buildId] so the SSE stream restarts
 *     (was BuildView.tsx:250, when the viewed build changes, NOT when the parent
 *      moved in FE-6b)     passes a fresh callback identity.
 *   - SegmentedPartitionEditor.tsx:565  uses [currentIds.join('|')] because
 *                         pendingFlipRef is populated only from a real click,
 *                         so typing and slider drags do not animate rows.
 *
 * Do not "fix" a dep array to satisfy this config. Carry each disable and its
 * comment with the code when it moves.
 *
 * THE SIZE ALLOWLIST AT THE BOTTOM IS A RATCHET, NOT A SETTLEMENT. Entries are
 * deleted as each refactor phase lands; the list shrinking monotonically toward
 * empty is the machine-checkable progress metric for the whole effort. Never
 * add an entry to make a new file pass.
 */
export default tseslint.config(
  {
    // dist/ is build output; coverage/ is generated; the fidelity runner is a
    // standalone .mjs script outside the type-checked project.
    ignores: ['dist/**', 'coverage/**', 'src/lib/*.mjs', '*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.es2023 },
    },
    linterOptions: {
      // Two of the eight pre-existing disables are currently inert:
      // PackageSearchDialog.tsx:246 (`no-console`, a rule this config does not
      // enable) and BasicPage.tsx:263 (`exhaustive-deps`, whose dep array is now
      // exhaustive). Both are KEPT deliberately — they document intent and
      // guard against a future config or dep-array change re-triggering the
      // rule — so ESLint is told not to report them as unused. Setting this to
      // `true` would push us toward deleting comments that carry rationale.
      reportUnusedDisableDirectives: false,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // ---- react-hooks v7's new correctness rules: WARN, not error ----
      // v7 added set-state-in-effect (16 hits) and refs (5 hits) beyond the
      // exhaustive-deps this repo was written against. They are spread over 17
      // files INCLUDING the primitives (Collapsible, Card, Slider, Combobox),
      // which is the signature of an established pattern rather than localised
      // bugs — the hits are documented prop-to-draft syncs (Slider.tsx:193) and
      // mount/animation lifecycle sequencing (Collapsible.tsx:72).
      //
      // Silencing them entirely would lose real signal; erroring on them would
      // force behaviour changes, and this refactor is behaviour-preserving. So:
      // visible on every run, blocking nothing. Revisit deliberately, as its
      // own change, once the decomposition has settled.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',

      // ---- Size ratchets: the whole point of adding a linter here ----
      // 400 lines is generous for a component file and still catches every
      // god component (1616 / 1614 / 1477 / 995).
      'max-lines': [
        'error',
        { max: 400, skipBlankLines: false, skipComments: false },
      ],
      // 150 including JSX. InteractivePage's single function body is 1104.
      'max-lines-per-function': [
        'error',
        { max: 150, skipBlankLines: false, skipComments: false },
      ],
      complexity: ['error', 15],
      // AGENTS.md: 4-5 params max, then a parameter object.
      'max-params': ['error', 5],

      // ---- Clean Code naming ----
      // NOT enforced via id-denylist. It was tried and rejected: it produced 19
      // errors, none of them a real naming problem. `info` is a toast SEVERITY
      // LEVEL and a key of Record<ToastVariant, ...> (Toast.tsx, store.ts), and
      // `data` is the DOM's own field name on MessageEvent — every hit in
      // BuildView is destructuring an SSE payload. A lint rule that fires on
      // domain vocabulary and on platform APIs trains people to ignore it.
      // Naming stays a review concern here.

      // Unused vars: defer to the TS-aware rule, and honour the repo's
      // deliberate `var _ = ...` style import-keepers / escape hatches.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` is a warning, not an error: it appears in existing code at
      // boundaries where the API shape is genuinely dynamic. Flagging without
      // failing keeps the signal without blocking the refactor.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Tests may be long and may reach for `any` when building fixtures; their
    // job is coverage, not architectural purity.
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    /* ------------------------------------------------------------------
     * SIZE ALLOWLIST — shrinks as the refactor lands. Do not add to it.
     *
     * Every path here exceeds max-lines and/or max-lines-per-function and/or
     * complexity TODAY. The corresponding refactor phase deletes its entry;
     * when this block holds nothing but the fenced file, the front-end
     * decomposition is done. That monotonic shrink is the machine-checkable
     * progress metric for the whole effort.
     *
     * Every path here genuinely violates — verified by stripping this block and
     * re-running, which is the ONLY honest check. (Running `eslint <one file>`
     * with the block still present tells you nothing: the entry silences the
     * very rule you are testing for.) Do not pad it "just in case": an
     * allowlist entry for a file that already passes is a silent licence for
     * that file to grow.
     *
     * PROGRESS: 21 -> 19.
     *   FE-2 only re-pathed these entries; the SET was unchanged, because a
     *   directory move cannot make a file shorter.
     *   FE-3 removed `features/partitions/SegmentedPartitionEditor.tsx` — the
     *   1614-line editor is now a 292-line container over parts/, hooks/ and a
     *   fully-tested model/. Every one of the 20 files it split into passes the
     *   ratchets on its own merit, with no new entries.
     *   FE-4 did NOT remove an entry, and that is worth stating plainly rather
     *   than glossing: PackageSearchDialog went 1477 -> 726 lines, its 9
     *   useState became one tested reducer, and 15 components plus 3 hooks came
     *   out of it — all of which clear the ratchets unaided. But its own JSX
     *   body is still ~650 lines (two columns, a result list and a footer in one
     *   return), so the file keeps its entry until that tree is split too.
     *   PackageSearchCombobox is untouched so far and keeps its entry.
     *   FE-5 (partial) likewise kept its entry: InteractivePage went 1578 -> 1177
     *   lines with the 7 option tables moved to a tested model/ and four
     *   components extracted, but its return is still one 8-Card JSX tree. The
     *   remaining split is FE-5c.
     *
     *   FE-6 removed `features/monitor/BuildView.tsx` — and it is the phase that
     *   PROVES the pattern below rather than just restating it. FE-6a/6b took
     *   the four-concern SSE effect, the fullscreen logic and formatBytes out,
     *   dropping 993 -> 801 lines, and the entry did not budge: still failing
     *   all three rules. FE-6c split the JSX return into 11 parts/ files, and
     *   the same file now passes unaided at 162 lines.
     *   BuildImagePage and BuildHistoryList are untouched and keep their entries.
     *
     * THE PATTERN WORTH NOTING: extracting logic and leaf components off a god
     * component does not clear its entry — only splitting its own JSX RETURN
     * does. Line count falls a long way before the ratchet notices.
     *
     * A COROLLARY FE-6 ran into: the ratchets count COMMENT lines
     * (skipComments: false, deliberately — a 400-line file is hard to hold in
     * your head whatever the lines contain). BuildView's body was 168 lines of
     * which 60 were comment, so the last step was moving each block of
     * rationale to the part whose code it now describes. That is the correct
     * move regardless of the linter: a comment explaining #1e1e1e belongs next
     * to #1e1e1e. Deleting rationale to hit a line target is NOT — every block
     * FE-6c removed from BuildView was verified present in its new home first.
     * ------------------------------------------------------------------ */
    files: [
      // FE-4 features/package-search/
      'src/features/package-search/PackageSearchDialog.tsx',
      'src/features/package-search/PackageSearchCombobox.tsx',
      // FE-5 features/compose-interactive/
      'src/features/compose-interactive/InteractivePage.tsx',
      // FE-6 features/monitor/
      'src/features/monitor/BuildImagePage.tsx',
      'src/features/monitor/BuildHistoryList.tsx',
      // FE-7 compose-basic / compose-advanced / yaml
      // Primitives over the limit. Trimmed opportunistically as their feature
      // phase touches them, not as a phase of their own.
      'src/components/layout/DialogOverlay.tsx',
      'src/components/layout/Card.tsx',
      'src/components/controls/MultiCombobox.tsx',
      'src/components/controls/Combobox.tsx',
      'src/components/controls/Slider.tsx',
      'src/components/feedback/BuildProgress.tsx',
      // FENCED by .claude/YAML-INTEGRITY.md — its 797 lines are a deliberate,
      // tested round-trip core. This entry is NOT scheduled for deletion; do
      // not restructure the file to hit a line target.
      'src/lib/draftFromYaml.ts',
    ],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
)
