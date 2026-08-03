/**
 * The exact ict command that produced this build, with a copy button.
 *
 * ⚠️ THE #1e1e1e / #d4d4d4 COLOURS ARE HARD-CODED ON PURPOSE and are NOT a
 * stranded inline style. Together with the log terminal and the YAML editor
 * this is one of three "code surfaces" that stay vscode-dark in BOTH app
 * themes, so they read as a single visual layer. Repointing them at
 * `var(--section-background)` / `var(--font-color)` would flip the block to a
 * light surface in light mode and break that family.
 *
 * (Wording, not just meaning, matters here: Tailwind v4 scans raw file TEXT
 * including comments, so a bare utility NAME in prose generates that utility.
 * The first draft of this comment used one such word to describe the light-mode
 * failure and silently grew the CSS by 219 bytes for a class nothing uses. If
 * you edit this block, re-diff the built CSS.)
 *
 * Extracted verbatim from BuildView, via BuildDetailsCard.
 */
export function CommandBlock({
  command,
  copyCommand,
}: {
  command: string
  copyCommand: () => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--muted-color)' }}
        >
          Command
        </span>
        <button
          className="cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          style={{
            borderColor: 'var(--border-color)',
            color: 'var(--muted-color)',
          }}
          onClick={copyCommand}
          title="Copy command to clipboard"
        >
          Copy
        </button>
      </div>
      <pre
        className="overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-relaxed"
        style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
        }}
      >
        {command}
      </pre>
    </div>
  )
}
