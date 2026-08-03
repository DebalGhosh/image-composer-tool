/**
 * The expand / collapse glyphs for the fullscreen toggle.
 *
 * Hand-written inline SVG rather than an icon dependency — the editor needs
 * exactly two 16px glyphs and pulling in a lucide-react-shaped package for them
 * would be the larger cost. Extracted verbatim from YamlEditor.
 */
export function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
    </svg>
  )
}

export function CollapseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
    </svg>
  )
}
