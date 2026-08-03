/**
 * Scoped CSS for the disk bar's stripe fill and its drag dividers.
 *
 * An inline <style> rather than Tailwind utilities or index.css because:
 *   - `repeating-linear-gradient` with these exact stops is not expressible as a
 *     utility, and
 *   - `.segpart-divider::before` styles a PSEUDO-ELEMENT, which Tailwind's
 *     arbitrary-value syntax cannot reach.
 *
 * Kept next to the components that use the class names rather than in
 * index.css, so a reader of DiskBar can find them. Extracted from
 * SegmentedPartitionEditor to bring its function body under the 150-line limit.
 *
 * ⚠️ The divider is only 8px wide and adjacent boundaries closer than that
 * overlap, leaving one undraggable. That is a known, pre-existing accessibility
 * gap (the per-row slider and EditableSize are the keyboard equivalents), not
 * something this extraction changed.
 */
export function SegmentedPartitionStyles() {
  return (
      <style>{`
      .segpart-stripe {
        background-image: repeating-linear-gradient(
          135deg,
          transparent 0px, transparent 6px,
          rgba(255,255,255,0.14) 6px, rgba(255,255,255,0.14) 12px
        );
      }
      .segpart-divider {
        position: absolute;
        top: 0; bottom: 0;
        width: 8px;
        margin-left: -4px;
        cursor: ew-resize;
        touch-action: none;
        z-index: 2;
      }
      .segpart-divider::before {
        content: '';
        position: absolute;
        left: 3px; top: 8px; bottom: 8px;
        width: 2px;
        background: rgba(255,255,255,0.55);
        border-radius: 1px;
        transition: background 140ms ease, box-shadow 140ms ease;
      }
      .segpart-divider:hover::before,
      .segpart-divider:focus-visible::before {
        background: rgba(255,255,255,0.95);
        box-shadow: 0 0 0 2px var(--classic-blue);
      }
      `}</style>
  )
}
