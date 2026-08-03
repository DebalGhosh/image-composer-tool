import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BuildSummaryPanels } from './BuildSummaryPanels'
import { UnavailableNotice } from './UnavailableNotice'
import { ArtifactoryDirectoryRow } from './ArtifactoryDirectoryRow'
import type { ComposeSummary } from '@/api/types'

/**
 * The summary panels are mostly declarative, but the row lists are built from
 * conditional expressions — every optional field contributes `null` when unset,
 * and SummaryPanel drops those. The failure mode is a row appearing with an
 * empty value, which reads as "the build has no hostname" rather than "we were
 * not told one".
 *
 * The composed strings (image name + version, the disk triple) are worth pinning
 * because they are assembled by concatenation, where a stray separator survives
 * every other check.
 */

const full: ComposeSummary = {
  vertical: 'Industrial',
  sku: 'SKU-9',
  platform: 'x86_64-generic',
  os: 'ubuntu-24.04',
  imageType: 'iso',
  imageName: 'my-image',
  imageVersion: '1.2.0',
  description: 'a test image',
  architecture: 'amd64',
  kernelVersion: '6.8.0',
  packageCount: 412,
  diskSize: '20GiB',
  partitionCount: 3,
  partitionTable: 'gpt',
  hostname: 'ict-host',
}

const minimal: ComposeSummary = {
  ...full,
  sku: '',
  imageVersion: '',
  description: '',
  kernelVersion: '',
  diskSize: '',
  partitionCount: 0,
  partitionTable: '',
  hostname: '',
}

describe('BuildSummaryPanels', () => {
  afterEach(cleanup)

  it('renders both headings', () => {
    render(<BuildSummaryPanels summary={full} />)
    expect(screen.getByText('Selection')).toBeTruthy()
    expect(screen.getByText('Image')).toBeTruthy()
  })

  it('upper-cases the image type', () => {
    render(<BuildSummaryPanels summary={full} />)
    expect(screen.getByText('ISO')).toBeTruthy()
  })

  it('appends the version in parentheses when there is one', () => {
    render(<BuildSummaryPanels summary={full} />)
    expect(screen.getByText('my-image (v1.2.0)')).toBeTruthy()
  })

  it('leaves the name bare when there is no version — no stray "(v)"', () => {
    render(<BuildSummaryPanels summary={minimal} />)
    expect(screen.getByText('my-image')).toBeTruthy()
    expect(screen.queryByText(/\(v\)/)).toBeNull()
  })

  it('composes the disk triple as size, TABLE, count', () => {
    render(<BuildSummaryPanels summary={full} />)
    expect(screen.getByText('20GiB, GPT, 3 partitions')).toBeTruthy()
  })

  it('suffixes the package count', () => {
    render(<BuildSummaryPanels summary={full} />)
    expect(screen.getByText('412 packages')).toBeTruthy()
  })

  it('OMITS the optional rows entirely rather than showing them empty', () => {
    render(<BuildSummaryPanels summary={minimal} />)
    for (const label of [
      'SKU',
      'Description',
      'Kernel',
      'Disk',
      'Hostname',
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
    // The unconditional rows are still there.
    expect(screen.getByText('Vertical')).toBeTruthy()
    expect(screen.getByText('Architecture')).toBeTruthy()
    expect(screen.getByText('Packages')).toBeTruthy()
  })

  it('does NOT add its own @container marker', () => {
    // The `@max-pane-4col:` prefix resolves against the PANE in BuildView. A
    // marker here would make this element the reference box, break the
    // breakpoint, and create a stacking context. Count must stay at 3 app-wide.
    const { container } = render(<BuildSummaryPanels summary={full} />)
    expect(container.querySelector('.\\@container')).toBeNull()
    expect(container.innerHTML).not.toContain('@container')
  })
})

describe('UnavailableNotice', () => {
  afterEach(cleanup)

  it('explains that the row is local-only rather than implying a failure', () => {
    render(<UnavailableNotice />)
    expect(
      screen.getByText('Build details are no longer available on the server.'),
    ).toBeTruthy()
    // The words that matter: it must not read as "the build failed".
    const text = screen.getByText(/only in local history/).textContent ?? ''
    expect(text).toContain('backend was likely')
    expect(text.toLowerCase()).not.toContain('failed')
  })
})

describe('ArtifactoryDirectoryRow', () => {
  afterEach(cleanup)

  const url = 'https://af.example.com/ict-local/images/'

  it('links and labels the directory', () => {
    render(<ArtifactoryDirectoryRow artifactoryUrl={url} copyPath={() => {}} />)
    expect(screen.getByText('Artifactory')).toBeTruthy()
    // Two anchors to the same place: the URL text itself and the Open button.
    const links = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(links).toEqual([url, url])
  })

  it('opens in a new tab, safely', () => {
    render(<ArtifactoryDirectoryRow artifactoryUrl={url} copyPath={() => {}} />)
    for (const a of screen.getAllByRole('link')) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('title-attributes the URL so a truncated one is still readable', () => {
    render(<ArtifactoryDirectoryRow artifactoryUrl={url} copyPath={() => {}} />)
    expect(screen.getByText(url).getAttribute('title')).toBe(url)
  })
})
