/**
 * Hamburger glyph for the template-YAML drawer trigger. Inline SVG with
 * `currentColor` per the existing icon convention in this codebase
 * (YamlEditor's ExpandIcon/CollapseIcon, Card's Chevron) — no icon
 * dependency.
 */
export function MenuIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  )
}
