import type { BuildDetails } from '@/api/types'

/**
 * Either the Jenkins coordinates or the local work/cache dirs — never both.
 * `details.jenkins` is the discriminator between the dispatched path and the
 * in-process one, so the whole `details` object is passed rather than
 * pre-narrowed fields.
 *
 * The Build row is itself conditional within the Jenkins branch: queue
 * resolution is asynchronous, so early polls report `buildNumber: 0` and the
 * `#0` link would 404. See hooks/useBuildStream's jenkinsMetaReady.
 *
 * Renders nothing on the local path when neither dir is set.
 *
 * Extracted verbatim from BuildView, via BuildDetailsCard.
 */
export function BuildMetadataList({ details }: { details: BuildDetails }) {
  return (
    details.jenkins ? (
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]"
        style={{ color: 'var(--font-color)' }}
      >
        <dt
          className="font-semibold uppercase tracking-wider"
          style={{ color: 'var(--muted-color)' }}
        >
          Worker
        </dt>
        <dd className="break-all font-mono">
          {details.jenkins.worker}
        </dd>
        {details.jenkins.buildNumber ? (
          <>
            <dt
              className="font-semibold uppercase tracking-wider"
              style={{ color: 'var(--muted-color)' }}
            >
              Build
            </dt>
            <dd className="break-all font-mono">
              <a
                className="underline"
                style={{ color: 'var(--classic-blue)' }}
                href={details.jenkins.buildUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                #{details.jenkins.buildNumber}
              </a>
            </dd>
          </>
        ) : null}
        <dt
          className="font-semibold uppercase tracking-wider"
          style={{ color: 'var(--muted-color)' }}
        >
          Job
        </dt>
        <dd className="break-all">
          <a
            className="font-mono underline"
            style={{ color: 'var(--classic-blue)' }}
            href={details.jenkins.jobUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {details.jenkins.jobUrl}
          </a>
        </dd>
      </dl>
    ) : (
      (details.workDir || details.cacheDir) && (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]"
          style={{ color: 'var(--font-color)' }}
        >
          {details.workDir && (
            <>
              <dt
                className="font-semibold uppercase tracking-wider"
                style={{ color: 'var(--muted-color)' }}
              >
                Work dir
              </dt>
              <dd className="break-all font-mono">
                {details.workDir}
              </dd>
            </>
          )}
          {details.cacheDir && (
            <>
              <dt
                className="font-semibold uppercase tracking-wider"
                style={{ color: 'var(--muted-color)' }}
              >
                Cache dir
              </dt>
              <dd className="break-all font-mono">
                {details.cacheDir}
              </dd>
            </>
          )}
        </dl>
      )
    )
  )
}
