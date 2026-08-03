import { api } from '@/api/client'

/**
 * The template filename plus a download link for the exact YAML that was sent
 * to the builder.
 *
 * The href goes through `api.templateUrl` so the client's BASE prefix is
 * applied — this is the path the byte-accuracy check reads, and it is what
 * proves the dispatched template matches the CLI's on-disk one.
 *
 * Extracted verbatim from BuildView, via BuildDetailsCard.
 */
export function TemplateRow({
  template,
  buildId,
}: {
  template: string
  buildId: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--muted-color)' }}
      >
        Template
      </span>
      <span
        className="font-mono text-[11px]"
        style={{ color: 'var(--font-color)' }}
      >
        {template}
      </span>
      <a
        className="cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
        style={{
          borderColor: 'var(--border-color)',
          color: 'var(--muted-color)',
        }}
        href={api.templateUrl(buildId)}
        download={template}
      >
        Download
      </a>
    </div>
  )
}
