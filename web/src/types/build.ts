/**
 * Cross-feature build types.
 *
 * `BuildStatus` was declared FOUR times, identically — `App.tsx`,
 * `BuildImagePage.tsx`, `BuildView.tsx` and `Header.tsx` — and it is the type on
 * the prop contract they pass between each other, so four private copies meant
 * four places to edit in lockstep for any lifecycle change.
 *
 * TWO NEAR-NEIGHBOURS ARE DELIBERATELY *NOT* FOLDED IN HERE:
 *
 *   - `Status` in BuildView (`'running' | 'cancelling' | 'cancelled' |
 *     'success' | 'failed'`) is a genuinely different set: it has no 'idle'
 *     (BuildView is not rendered before a build exists) and it adds
 *     'cancelling', a transient state that exists only inside that component
 *     while Jenkins acknowledges a stop. Merging them would either leak
 *     'cancelling' into the app-wide indicator or drop it from BuildView.
 *
 *   - `BuildHistoryStatus` in `lib/buildHistory.ts` has the same five members
 *     today, but it is the shape PERSISTED under `ict.buildHistory.v1`. Aliasing
 *     it to this type would couple a localStorage schema to a UI type, so a
 *     future UI-only lifecycle state would silently change what is written to
 *     users' browsers. They are kept structurally compatible on purpose, not
 *     unified.
 */

/**
 * The app-wide build lifecycle, as surfaced by the header indicator and passed
 * along the App -> BuildImagePage -> BuildView prop chain.
 *
 * 'idle' means "nothing running" — it is the resting state, and also where a
 * finished-and-acknowledged build returns to.
 */
export type BuildStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'
