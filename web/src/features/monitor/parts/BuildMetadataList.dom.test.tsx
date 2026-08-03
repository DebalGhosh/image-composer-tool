import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BuildMetadataList } from './BuildMetadataList'
import type { BuildDetails } from '@/api/types'

/**
 * BuildMetadataList is a three-way branch masquerading as markup:
 *   jenkins present   -> Worker / [Build] / Job
 *   no jenkins, dirs  -> Work dir / Cache dir, each independently optional
 *   no jenkins, no dirs -> nothing at all
 *
 * The `[Build]` row is itself conditional, and that is the one with a live
 * failure mode: Jenkins queue resolution is asynchronous, so early polls return
 * `buildNumber: 0`, and a `#0` link would 404. Pinned here so nobody
 * "simplifies" the truthiness test away.
 */

const base = {
  command: 'ict compose …',
  template: 'seed.yaml',
} as BuildDetails

function withJenkins(over: Partial<BuildDetails['jenkins']> = {}): BuildDetails {
  return {
    ...base,
    jenkins: {
      worker: 'worker-07',
      buildNumber: 18,
      buildUrl: 'https://jenkins.example.com/job/ict/18/',
      jobUrl: 'https://jenkins.example.com/job/ict/',
      ...over,
    },
  } as BuildDetails
}

describe('BuildMetadataList', () => {
  afterEach(cleanup)

  describe('the dispatched (Jenkins) path', () => {
    it('shows Worker, Build and Job', () => {
      render(<BuildMetadataList details={withJenkins()} />)
      expect(screen.getByText('Worker')).toBeTruthy()
      expect(screen.getByText('worker-07')).toBeTruthy()
      expect(screen.getByText('Build')).toBeTruthy()
      expect(screen.getByText('#18')).toBeTruthy()
      expect(screen.getByText('Job')).toBeTruthy()
    })

    it('links the build number at the SPECIFIC build, not the job', () => {
      render(<BuildMetadataList details={withJenkins()} />)
      const link = screen.getByRole('link', { name: '#18' })
      expect(link.getAttribute('href')).toBe(
        'https://jenkins.example.com/job/ict/18/',
      )
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('OMITS the Build row while buildNumber is still 0', () => {
      // Queue resolution is async: the first polls come back with 0. A `#0`
      // link would 404 on Jenkins.
      render(<BuildMetadataList details={withJenkins({ buildNumber: 0 })} />)
      expect(screen.queryByText('Build')).toBeNull()
      expect(screen.queryByText('#0')).toBeNull()
      // The rest of the list still renders.
      expect(screen.getByText('Worker')).toBeTruthy()
      expect(screen.getByText('Job')).toBeTruthy()
    })

    it('still renders Worker when the worker name has not resolved yet', () => {
      render(<BuildMetadataList details={withJenkins({ worker: '' })} />)
      // The label is unconditional — an empty value shows as an empty cell
      // rather than the row vanishing and the list reflowing mid-build.
      expect(screen.getByText('Worker')).toBeTruthy()
    })

    it('ignores workDir/cacheDir entirely when jenkins is present', () => {
      const d = {
        ...withJenkins(),
        workDir: '/tmp/ict-work',
        cacheDir: '/var/cache/ict',
      } as BuildDetails
      render(<BuildMetadataList details={d} />)
      expect(screen.queryByText('Work dir')).toBeNull()
      expect(screen.queryByText('Cache dir')).toBeNull()
    })
  })

  describe('the local (in-process) path', () => {
    it('shows both dirs when both are set', () => {
      const d = {
        ...base,
        workDir: '/tmp/ict-work',
        cacheDir: '/var/cache/ict',
      } as BuildDetails
      render(<BuildMetadataList details={d} />)
      expect(screen.getByText('Work dir')).toBeTruthy()
      expect(screen.getByText('/tmp/ict-work')).toBeTruthy()
      expect(screen.getByText('Cache dir')).toBeTruthy()
      expect(screen.getByText('/var/cache/ict')).toBeTruthy()
    })

    it('shows only work dir when cache dir is unset', () => {
      const d = { ...base, workDir: '/tmp/ict-work' } as BuildDetails
      render(<BuildMetadataList details={d} />)
      expect(screen.getByText('Work dir')).toBeTruthy()
      expect(screen.queryByText('Cache dir')).toBeNull()
    })

    it('shows only cache dir when work dir is unset', () => {
      const d = { ...base, cacheDir: '/var/cache/ict' } as BuildDetails
      render(<BuildMetadataList details={d} />)
      expect(screen.queryByText('Work dir')).toBeNull()
      expect(screen.getByText('Cache dir')).toBeTruthy()
    })

    it('renders NOTHING when there is no jenkins and no dirs', () => {
      const { container } = render(<BuildMetadataList details={base} />)
      // Not an empty <dl> with a border — genuinely nothing, so the parent's
      // space-y-4 does not leave a gap.
      expect(container.querySelector('dl')).toBeNull()
      expect(container.textContent).toBe('')
    })
  })
})
