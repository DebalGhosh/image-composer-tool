/**
 * monitor — the Monitor Builds tab: history list plus an SSE-driven detail pane.
 *
 * Public surface is BuildImagePage alone. It owns the two-pane split and
 * prop-drills to BuildView / BuildHistoryList, which stay feature-private —
 * App.tsx should not be able to mount a BuildView without the page that manages
 * its selection state. parts/, hooks/ and model/ are private a level deeper
 * still: they exist to serve BuildView and are not promoted to components/ or
 * the repo-wide hooks/ until something outside this feature needs them.
 *
 * BuildView is a pure composer — the pane element plus six children in order.
 * All its state comes from hooks/useBuildStream (SSE + poll + the one-shot
 * Jenkins-metadata latch, four concerns that share mutable local state and
 * cannot be split) and hooks/useTerminalFullscreen.
 *
 * ⚠️ NAMED `monitor`, NOT `builds`, and that is load-bearing. The repo's
 * .gitignore carries an unanchored `builds/` (for Go build artefacts), and
 * Tailwind v4 honours .gitignore when it scans for class names — so a
 * `features/builds/` directory is silently skipped and every utility used only
 * in it vanishes from the CSS. `git mv` still tracks such files, so nothing
 * fails except the styling, which no gate can see. Do not rename this back.
 */
export { BuildImagePage } from './BuildImagePage'
