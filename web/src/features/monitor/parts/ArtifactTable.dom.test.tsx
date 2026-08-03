import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArtifactTable } from './ArtifactTable'
import type { Artifact } from '@/api/types'

/**
 * ArtifactTable carries three real derivations behind its markup, and each has
 * a way to go wrong that a reader would not spot:
 *   - `href` falls back to the local proxy path when the artifact has no URL;
 *   - `key` is name+index, because Jenkins repeats filenames across nested
 *     relative paths;
 *   - the row tooltip appends a formatted size ONLY when one is known.
 *
 * These are pinned as CHARACTERISATION tests: the values come from the code as
 * it behaved before FE-6c split it out of BuildView, not from an opinion about
 * what it should do.
 *
 * NOTE ON THE FIXTURES: `type` is `'image' | 'sbom'` and nothing else. It looks
 * like a file-extension field and is not — the backend's classifyArtifact()
 * (internal/api/builds.go) returns 'sbom' for names containing sbom/spdx and
 * 'image' for everything else, so even UPLOAD-MANIFEST.txt arrives as 'image'.
 * The first draft of this file used 'iso'/'txt'/'log' and only tsc objected.
 */

const published: Artifact = {
  name: 'my-image.iso',
  type: 'image',
  path: 'ict-local/images/my-image.iso',
  url: 'https://af.example.com/ict-local/images/my-image.iso',
  size: 966_002_688,
  source: 'artifactory',
}

const archived: Artifact = {
  name: 'UPLOAD-MANIFEST.txt',
  type: 'image',
  source: 'jenkins',
} as Artifact

/**
 * Find a row by its NAME cell specifically, not by any cell containing the
 * text. An artifact with neither `path` nor `url` renders its name in BOTH the
 * Name and Path columns (`display = path ?? url ?? name`), so a bare
 * `getByText` matches twice and throws. Scoping to the first `<td>` is also
 * what makes the precedence test below meaningful.
 */
function rowFor(name: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll('tbody tr'))
  const row = rows.find(
    (r) => r.querySelector('td')?.textContent?.trim() === name,
  )
  if (!row) throw new Error(`no row whose NAME cell is ${name}`)
  return row as HTMLElement
}

describe('ArtifactTable', () => {
  afterEach(cleanup)

  it('renders the four documented columns, in order', () => {
    render(
      <ArtifactTable artifacts={[published]} buildId="b1" copyPath={vi.fn()} />,
    )
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['Name', 'Type', 'Path', 'Actions'])
  })

  it('links the NAME when the artifact carries a url, and does not when it does not', () => {
    render(
      <ArtifactTable
        artifacts={[published, archived]}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    // Published: the name itself is an anchor to the Artifactory file URL.
    const named = screen.getByRole('link', { name: 'my-image.iso' })
    expect(named.getAttribute('href')).toBe(published.url)
    expect(named.getAttribute('target')).toBe('_blank')
    expect(named.getAttribute('rel')).toBe('noopener noreferrer')
    // Archived: plain text, no anchor around the name.
    expect(
      screen.queryByRole('link', { name: 'UPLOAD-MANIFEST.txt' }),
    ).toBeNull()
  })

  it('falls back to the local proxy path for the DOWNLOAD href when there is no url', () => {
    render(
      <ArtifactTable artifacts={[archived]} buildId="b7" copyPath={vi.fn()} />,
    )
    const dl = screen.getByRole('link', { name: 'Download' })
    // artifactUrl(buildId, name) — the proxy route, not an absolute URL.
    expect(dl.getAttribute('href')).toContain('b7')
    expect(dl.getAttribute('href')).toContain('UPLOAD-MANIFEST.txt')
    expect(dl.getAttribute('href')).not.toContain('af.example.com')
    // No target/rel on the proxy path: it is same-origin.
    expect(dl.hasAttribute('target')).toBe(false)
    expect(dl.hasAttribute('rel')).toBe(false)
  })

  it('prefers the absolute url for the download href when one exists', () => {
    render(
      <ArtifactTable artifacts={[published]} buildId="b7" copyPath={vi.fn()} />,
    )
    const dl = screen.getByRole('link', { name: 'Download' })
    expect(dl.getAttribute('href')).toBe(published.url)
    expect(dl.getAttribute('target')).toBe('_blank')
  })

  it('puts the formatted size in the ROW TOOLTIP, not a fifth column', () => {
    render(
      <ArtifactTable artifacts={[published]} buildId="b1" copyPath={vi.fn()} />,
    )
    // 966002688 -> '921 MiB' per model/bytes.
    expect(rowFor('my-image.iso').getAttribute('title')).toBe('my-image.iso — 921 MiB')
    // Still four columns — the size did NOT become one.
    expect(screen.getAllByRole('columnheader')).toHaveLength(4)
  })

  it('uses the bare name as the tooltip when size is unknown', () => {
    render(
      <ArtifactTable artifacts={[archived]} buildId="b1" copyPath={vi.fn()} />,
    )
    expect(rowFor('UPLOAD-MANIFEST.txt').getAttribute('title')).toBe('UPLOAD-MANIFEST.txt')
  })

  it('shows path ?? url ?? name in the PATH column, in that precedence', () => {
    const urlOnly = {
      name: 'x.img',
      type: 'image',
      url: 'https://af.example.com/x.img',
    } as Artifact
    const nameOnly = { name: 'y.log', type: 'image' } as Artifact
    render(
      <ArtifactTable
        artifacts={[published, urlOnly, nameOnly]}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    // published has BOTH a path and a url -> the PATH wins. This is the only
    // row that distinguishes the two orderings, so assert on the exact cell
    // rather than the row: the url appears elsewhere in the row (the name
    // anchor's href, the Download href), so a `toContain` on row text passes
    // under either precedence and pins nothing.
    const pathCell = rowFor('my-image.iso').querySelectorAll('td')[2]
    expect(pathCell?.textContent?.trim()).toBe('ict-local/images/my-image.iso')
    expect(pathCell?.textContent).not.toContain('https://')
    // urlOnly has no path -> url shows
    expect(rowFor('x.img').textContent).toContain('https://af.example.com/x.img')
    // nameOnly has neither -> the name is repeated in the path column
    expect(
      rowFor('y.log').querySelectorAll('td')[2]?.textContent?.trim(),
    ).toBe('y.log')
  })

  describe('the Copy button', () => {
    const copy = vi.fn()
    beforeEach(() => copy.mockClear())

    it('copies the URL rather than the displayed path, when a url exists', async () => {
      render(
        <ArtifactTable artifacts={[published]} buildId="b1" copyPath={copy} />,
      )
      await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
      // The PATH column shows a repo-relative path that is not independently
      // fetchable. The full URL is what an operator pastes into curl.
      expect(copy).toHaveBeenCalledWith(published.url)
      expect(copy).not.toHaveBeenCalledWith(published.path)
    })

    it('copies the display value when there is no url', async () => {
      render(
        <ArtifactTable artifacts={[archived]} buildId="b1" copyPath={copy} />,
      )
      await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(copy).toHaveBeenCalledWith('UPLOAD-MANIFEST.txt')
    })

    it('labels itself by whether it will copy a URL or a path', () => {
      render(
        <ArtifactTable
          artifacts={[published, archived]}
          buildId="b1"
          copyPath={copy}
        />,
      )
      const titles = screen
        .getAllByRole('button', { name: 'Copy' })
        .map((b) => b.getAttribute('title'))
      expect(titles).toEqual([
        'Copy download URL to clipboard',
        'Copy path to clipboard',
      ])
    })
  })

  it('renders BOTH rows when Jenkins repeats a filename across nested paths', () => {
    // The reason `key` is name+index and not name. With a name-only key React
    // would warn and drop one of these.
    const dupA = {
      name: 'build.log',
      type: 'image',
      path: 'phase1/build.log',
    } as Artifact
    const dupB = {
      name: 'build.log',
      type: 'image',
      path: 'phase2/build.log',
    } as Artifact
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ArtifactTable
        artifacts={[dupA, dupB]}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(screen.getAllByText('build.log')).toHaveLength(2)
    expect(screen.getByText('phase1/build.log')).toBeTruthy()
    expect(screen.getByText('phase2/build.log')).toBeTruthy()
    // No duplicate-key warning.
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('same key')),
    ).toHaveLength(0)
    warn.mockRestore()
  })

  it('sets download={name} so the browser saves under the artifact name', () => {
    render(
      <ArtifactTable artifacts={[published]} buildId="b1" copyPath={vi.fn()} />,
    )
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('my-image.iso')
  })
})
