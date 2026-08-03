/**
 * Fold-gutter marker builder.
 *
 * ⚠️ THIS IS NOT A REACT COMPONENT AND MUST NOT BECOME ONE. CodeMirror's
 * `FoldGutterConfig.markerDOM` callback is required to RETURN an HTMLElement
 * synchronously — there is no place to mount a React tree, and rendering one
 * into a detached node per gutter row would be both slower and wrong. Hence
 * `document.createElementNS` and inline `.style` assignments.
 *
 * It lives in parts/ next to the icons because it plays the same role (a glyph
 * for the editor chrome), but it is a plain .ts module, not .tsx, precisely to
 * make the distinction visible in the file listing.
 *
 * The inline styles here are NOT part of the app's `style={{}}` census: that
 * census counts JSX style objects carrying `var(--…)` theme tokens, and these
 * are imperative DOM writes using `currentColor` so the gutter inherits the
 * surrounding line-number tone in both themes.
 *
 * Extracted verbatim from YamlEditor.
 */
// Path/viewBox copied from the accordion Card's Chevron so the fold-gutter
// markers speak the same visual vocabulary as every other "reveal/dismiss"
// affordance in the app. Uses raw DOM (not React) because CodeMirror's
// FoldGutterConfig.markerDOM callback must return an HTMLElement.
const FOLD_CHEVRON_PATH =
  'M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z'
const FOLD_CHEVRON_VIEWBOX = '0 0 20 20'
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build a marker element for the fold gutter. `open=true` means the line
 * IS foldable (currently open) — chevron points down, inviting a fold.
 * `open=false` means the line is currently folded — chevron rotated -90°
 * (points right, standard "closed" affordance).
 */
export function buildFoldChevron(open: boolean): HTMLSpanElement {
  const wrap = document.createElement('span')
  // Inline-flex so the wrap sizes to the SVG and centers vertically inside
  // the gutter row. Muted color matches the surrounding line-number tone.
  wrap.style.display = 'inline-flex'
  wrap.style.alignItems = 'center'
  wrap.style.justifyContent = 'center'
  wrap.style.width = '14px'
  wrap.style.height = '14px'
  wrap.style.cursor = 'pointer'
  wrap.setAttribute('aria-hidden', 'true')

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', FOLD_CHEVRON_VIEWBOX)
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.style.color = 'currentColor'
  // Down when open (matches accordion "open=points down" convention).
  // -90° when folded so it points right, echoing the standard tree-node
  // "closed" marker without breaking the shared chevron shape.
  svg.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)'
  svg.style.transition = 'transform 180ms cubic-bezier(0.22, 0.7, 0.32, 1)'

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', FOLD_CHEVRON_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  wrap.appendChild(svg)
  return wrap
}
