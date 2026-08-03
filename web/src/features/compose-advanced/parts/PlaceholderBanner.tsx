import { Card } from '@/components/layout/Card'

/**
 * The unreplaced-placeholder warning and its override checkbox.
 *
 * ⚠️ THE OVERRIDE IS SCOPED TO PLACEHOLDERS ONLY. It clears
 * `blockedByPlaceholders` and nothing else — an empty, oversized or malformed
 * buffer stays blocked. See model/buildGates.ts.
 *
 * The seed loader resets it on every successful load, because a fresh template
 * brings a fresh set of placeholders and old consent must not carry over.
 *
 * Rendered by the parent only when `placeholders.length > 0`, so this component
 * does not repeat that test.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function PlaceholderBanner({
  placeholders,
  override,
  setOverride,
}: {
  placeholders: string[]
  override: boolean
  setOverride: (next: boolean) => void
}) {
  return (
    <Card variant="warning" title="Placeholder tokens detected" className="mt-5">
      <ul className="list-disc pl-5 font-mono text-xs">
        {placeholders.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        These are unfilled markers from the reference templates and will make the
        build fail. Replace them, or acknowledge the override below to build anyway.
      </p>
      <label className="mt-3 flex cursor-pointer items-center gap-3 text-xs">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
          className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
        />
        I know these placeholders are present; build anyway.
      </label>
    </Card>
  )
}
