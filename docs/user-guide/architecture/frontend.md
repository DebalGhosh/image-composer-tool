# Frontend architecture

Deep-dive on the React + TypeScript SPA that lives under `web/`. Audience is
engineers extending the UI — the main backend and the ict-pkgsvc microservice
are covered separately in [`backend.md`](./backend.md) and
[`ict-pkgsvc.md`](./ict-pkgsvc.md).

## Overview

The frontend is a Vite-built single-page app rendered by `web/src/main.tsx`
into `web/index.html`. Two deploy shapes are supported from the same source
tree: a single Go binary that embeds `web/dist/` via `//go:embed`, or the
container topology used for the fork's Jenkins-dispatch farm, where nginx
serves the built bundle and reverse-proxies `/api/` to the Go server. In
development you skip both — Vite's dev server on port 5173 hot-reloads the
SPA and proxies `/api` into the backend directly.

```
                     production (containers)              development
                     ────────────────────────             ────────────────────
  Browser ─────────► nginx :8080 (container)              Vite dev :5173
                       │  / → /usr/share/nginx/html         │  / → SPA (HMR)
                       └─ /api/ → http://backend:8080      └─ /api → VITE_API_TARGET
                                                              (default
                                                               http://localhost:8080)
```

The Go server and ict-pkgsvc are separate concerns and are documented in
their own architecture notes. This document describes only the SPA and the
two shells (nginx, Vite dev server) that host it.

## Vite + build

`web/vite.config.ts` is the entire build config — `@vitejs/plugin-react`,
`@tailwindcss/vite`, dev-time proxy, and an explicit `build.outDir` of
`dist/` so the embed step downstream is unambiguous. The proxy block is the
only knob:

    server: {
      host: true,
      proxy: {
        '/api': {
          target: process.env.VITE_API_TARGET || 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },

`host: true` binds to all interfaces so a remote browser (SSH-tunnelled dev
box, another host on the LAN) can reach the dev server without a tunnel.
`VITE_API_TARGET` is the single override for parallel test instances that
need to hit a non-default Go port (e.g. `http://localhost:8081` when the
primary server on `:8080` must stay untouched).

`npm run build` runs `tsc -b && vite build` and drops the hashed bundle into
`web/dist/`. That directory is consumed two ways: embedded into the Go
binary via `internal/webui/embed.go` for single-binary deploys, or copied
into `/usr/share/nginx/html` by the second stage of `Dockerfile.frontend`
for the multi-container topology.

## Frontend tabs

`web/src/components/Header.tsx` renders four top-level views, backed by the
`View` union in `web/src/lib/urlState.ts`:

    export type View = 'basic' | 'advanced' | 'interactive' | 'builds'

The tab labels shown to the user are `Basic`, `Advanced`, `Interactive`,
`Monitor Builds`. `App.tsx` renders all four pages every time and gates
visibility with `hidden={view !== '<id>'}`:

    <div hidden={view !== 'basic'}>       <BasicPage … /> </div>
    <div hidden={view !== 'advanced'}>    <AdvancedPage … /> </div>
    <div hidden={view !== 'interactive'}> <InteractivePage … /> </div>
    <div hidden={view !== 'builds'}>      <BuildImagePage … /> </div>

Because every page stays mounted, tab-switches preserve unsaved form state
without a store round-trip (Zustand persistence is a belt-and-braces on top
of this — see below). The active view is mirrored into the URL as `?view=…`
via `replaceUrlState` in `urlState.ts`, so browser back/forward parses the
query on `popstate` and updates state. The default view (`basic`) is
omitted from the query so a URL sitting on Basic reads as clean `/`.

### Basic tab (BasicPage.tsx)

Six cascading dropdowns — `vertical → sku → platform → os → kernel? →
imageType` — driven by `cascadingOptions()` in `store.ts`. The kernel step
appears only when a combination in the manifest actually carries a `kernel`
field, so RT vs standard surfaces exactly where the metadata offers it.

Two behaviours are worth calling out. First, single-option auto-fill: the
effect at `BasicPage.tsx:69-111` walks the cascade top-down and, whenever a
dimension collapses to exactly one option and its enabling gate is met, it
calls `setField` (not the local `setSel` wrapper — that would yank an open
review). Setting state schedules a re-render, `useMemo` recomputes options
for the new selection, and the same effect fires again for the next
dimension. It terminates the moment it hits a dimension with 0 or 2+
options, or one the user has already picked.

Second, auto-open review: `autoOpenedRef` (`BasicPage.tsx:37`) is a
component-lifetime latch that flips to `true` the first time the cascade
reaches `complete`. The effect at `:197-219` fires an `api.compose()` in an
async IIFE and only sets the latch on a *successful, non-cancelled*
response — so a transient network failure on the first attempt doesn't
permanently kill auto-reveal. A `cancelled` flag inside the effect's
cleanup drops stale responses whose fetch was still in flight when the user
started editing again.

The right pane is a `<LiveYamlPreview>` sliding in from 0% to 45% width via
imperative `Panel.resize()` and requestAnimationFrame — the panel library
doesn't animate size on its own.

### Advanced tab (AdvancedPage.tsx)

A single raw-YAML editor plus a seed dropdown. The seed dropdown is fed
straight from `manifest.combinations`; picking one calls `api.compose()`
and stuffs the returned YAML into the buffer (confirmation prompt when the
current buffer is non-empty). `↻ Reload` re-fires the same seed against the
current dropdown value.

The editor itself is `YamlEditor` (`web/src/components/YamlEditor.tsx`), a
CodeMirror 6 wrapper. Every YamlEditor instance carries an
absolute-positioned expand button; clicking it flips the SAME wrapper to
`position: fixed`, `inset: 0`, `zIndex: 60` — CodeMirror stays mounted, so
cursor position, scroll offset and undo history all survive the transition.
Only `height` is swapped (to `calc(100vh - 52px)`) and the editor
re-layouts to fill the viewport without a remount. Body scroll is locked
via `document.body.style.overflow = 'hidden'` (`YamlEditor.tsx:386-404`),
Escape closes via a capture-phase `keydown` on `document`, focus is
contained by a Tab/Shift-Tab handler on the wrapper plus a `focusin` net
that pulls stray focus back to the toggle button. A module-level singleton
(`activeFullscreenOwner`) makes sure only one editor is fullscreen at a
time — other instances hide their expand button while another owns it.

Live YAML validity is tracked by `validateYaml()` (`AdvancedPage.tsx:33-54`)
which calls `YAML.parse` on every keystroke and pulls `linePos[0]` out of
`YAMLParseError` for the inline pill. Build is blocked on empty, on parse
errors, on `>200 KB` (`MAX_YAML_BYTES`), or on the presence of
`PLACEHOLDER_TOKENS` (`<URL>`, `<PUBLIC_KEY_URL>`, `/path/to/`) unless the
user explicitly acknowledges the override checkbox.

### Interactive tab (InteractivePage.tsx)

Form-driven CoreV1 composer. The round-trip is:

    seed (compose?form=merged) → parseYamlToDraft → InteractiveDraft
                                       (edit)
                                        ▼
    applyOverrides(draft) → YAML → api.dispatchJenkins → Build

`InteractiveDraft` lives in `store.ts` (see the `interactiveDraft` slice) so
tab switches don't discard edits. `parseYamlToDraft` and `applyOverrides`
are pure functions in `web/src/lib/draftFromYaml.ts` — the same YAML round-
trips through them, with anything unexposed (shell `configurations[]`,
custom package repositories) preserved verbatim on `draft.baseDoc`.

The page renders eight collapsible `<Card>` sections: `Seed from template`,
`Image`, `Target` (OS/dist/arch/imageType), `Disk & partitions`, `Kernel`,
`Packages`, `System`, and — only when the seed carried them — `Inherited
from seed`. The right pane is a live `<InteractiveYamlPreview>` that
re-serialises `memoedYaml` from `applyOverrides(storeDraft)` on every draft
change; `applyOverrides` throwing surfaces in the pane as an inline error
rather than crashing the tab.

The Packages card hosts two package-search surfaces sharing the same
`values` / `onChange` contract — see the [Package search UX](#package-
search-ux) section. The Cmd/Ctrl+K global shortcut that opens the expanded
dialog is registered document-level and guarded by `rootRef.current.
offsetParent === null` (`InteractivePage.tsx:170-184`) so it only fires
when this tab is the active view — `hidden=""` sets `display: none` per
the HTML spec and any element inside a `display: none` subtree has
`offsetParent === null`.

### Monitor Builds tab (BuildImagePage.tsx)

Resizable split-pane: a session-persisted `<BuildHistoryList>` on the left,
the currently-selected `<BuildView>` on the right. Layer three of state:
`entries` from `useBuildHistory()`, `selectedBuildId` also from the hook,
and `liveBuildId` (in `App.tsx`) as a one-shot bridge for the freshly-
dispatched build that hasn't been committed to selection yet.
`activeBuildId` in `BuildImagePage.tsx:96-100` resolves precedence:
explicit selection first, live dispatch second, most-recent entry third.

Two details matter. First, `<BuildView key={activeBuildId} …>`
(`BuildImagePage.tsx:202`) forces a full remount when the user clicks a
different history row. Without the key `BuildView`'s `buildId`-scoped
`useEffect` just re-runs — but in-flight `api.buildDetails` polls and
already-dispatched `EventSource` messages from the *old* build could still
land `setState` calls into the same component instance, painting the new
pane with old data. Symptom in the wild: "clicking a historical row shows
some random other build's log."

Second, `unavailable` empty state. `BuildView.tsx:147-153` catches
`ApiError.status === 404` from the details poll (the build isn't in the
backend's in-memory tracker — usually because the backend was restarted
after the row was written to `localStorage`) and flips a flag that renders
an explicit "Build details are no longer available on the server" panel at
`BuildView.tsx:272-294`. The status pill in `BuildHistoryList` still shows
whatever was last written to `localStorage` — no lying, no spurious
"failed".

## API client

`web/src/api/client.ts` centralises every backend call through a single
`jsonFetch<T>()` wrapper that prefixes `BASE = '/api/v1'` and unwraps
`error.message` from the JSON body when `res.ok === false`. Non-2xx
responses throw `ApiError` (also exported), which carries `status` — the
only callers that inspect it today are `BuildView` (see the 404 handling
above) and `PackageSearchDialog` (drops silent aborts). Every route on the
`api` object:

- `getManifest()` — `GET /manifest`.
- `compose(req)` / `composeMerged(req)` — `POST /templates/compose`; the
  merged variant appends `?form=merged` so the Interactive seed round-trip
  gets the fully-overlaid YAML.
- `searchPackages(req)` — `GET /packages?os=…&arch=…&q=…&limit=…`, legacy
  9-field shape.
- `searchPackagesFull(req)` — same query surface with `fields=full` appended;
  returns the enriched `PackageDetails` shape.
- `packageDetails(os, arch, name)` — single-record lookup at
  `GET /packages/{os}/{arch}/{name}`; 404 when `PKGSVC_URL` is empty on the
  main backend, and the dialog degrades to list-response data.
- `dispatchJenkins(yaml)` — `POST /jenkins/dispatch`, returns `BuildAccepted`.
- `cancelBuild(buildId)` — `POST /builds/{id}/cancel`.
- `buildDetails(buildId)` — `GET /builds/{id}/details`.
- `logsUrl(buildId)` / `templateUrl(buildId)` — return strings, consumed by
  `new EventSource(...)` and `<a href>` respectively.

Types live in `web/src/api/types.ts`. `PackageEntry` is the byte-identical
9-field legacy shape (`name`, `version`, `description`, `arch`, `section`,
`repository`, `os`, `type`, optional `provides` string list) that the
inline `PackageSearchCombobox` has consumed since day one.
`PackageDetails` is the enriched shape used by the expanded dialog —
strictly a superset, with the identity fields matching `PackageEntry` and
every enriched field optional (AppStream / popcon coverage is partial
upstream). Optional fields include `homepage`, `installedSize`, `tags`,
`categories`, `keywords`, `tasks`, `screenshots`, `depends`, `recommends`,
`suggests`, `popularity` (`inst`/`vote`/`recent`/`old`), and a re-typed
`provides` sub-object with `binary` / `library` / `mimetype` / `dbus` /
`python` / `font` / `firmware` string lists.

## Package search UX

Two surfaces share a `values: string[]` / `onChange` contract, so a
package added by either shows up in the other on the next render.

### Compact PackageSearchCombobox

Inline multi-select on the Interactive tab's Packages card
(`web/src/components/PackageSearchCombobox.tsx`). Every keystroke fires an
`api.searchPackages` after a 200 ms debounce (`DEBOUNCE_MS` in
`web/src/components/packageSearchShared.ts`); results are reindexed
per-response into a fresh `MiniSearch` so client-side reranking always
matches the server's latest hand-off. Grouping is a prefix heuristic in
`groupFor(name)`:

- `Base` — `ubuntu-*`, `apt`, `bash`, `sudo`, `systemd*`, `openssh-*`, etc.
- `Boot & kernel` — `linux-image*`, `linux-headers*`, `grub-*`, `systemd-boot`,
  `dracut`, `cryptsetup`, `efibootmgr`.
- `Firmware` — `firmware-*`, `linux-firmware`.
- `AI & Media (Intel)` — `openvino*`, `intel-oneapi-*`, `libze*`, `libigfx*`,
  `intel-npu-*`, `intel-driver-*`, `intel-media-*`, `librealsense*`.
- `ROS 2` — `ros-*`.
- `Other` — everything else.
- `User-added` — the `+ Add "…"` synthetic row surfaced when the query is a
  valid package name (`PKG_NAME_RE`), isn't already in the visible list, and
  isn't already selected.

Stale-response guard: `fetchIdRef` is incremented at start-of-fetch and
checked when the response lands, so an older request that arrives after a
newer one is dropped. Cheaper than `AbortController` for this surface and
works across React strict-mode double-invocation.

### Expanded PackageSearchDialog

Palette-style overlay at `web/src/components/PackageSearchDialog.tsx`,
opened from three triggers: the `Advanced search` button on the Packages
card, `Cmd/Ctrl+K` when the Interactive tab is on screen, or programmatic
`onClose={…}`. Design inspiration is Intel Smart Software Factory UI's
`DialogWrapper` — a fixed mask over `rgba(36,37,40,0.8)` with an inner
container that transitions in via a `.visible` class toggled one tick after
mount. This fork's version keeps the class-toggle-after-mount pattern (see
`DialogOverlay.tsx:113-126`) but softens the backdrop to
`rgba(0, 0, 0, 0.55)` plus `backdrop-filter: blur(4px)` so the dimming
pairs with the frosted-glass surfaces used elsewhere (BasicPage's sticky
action footer, for example). Everything else is bolted on:

- Esc-to-close via a capture-phase `document` keydown.
- Backdrop mousedown-to-close (`onMaskMouseDown` guards `e.target === maskRef`).
- Focus trap: Tab/Shift-Tab cycles between focusables inside the panel;
  `focusin` net returns stray focus to the panel's auto-focus target.
- Body scroll lock while mounted; restored on unmount.
- `role="dialog"` + `aria-modal="true"` + WAI-ARIA APG combobox pattern on
  the input (`role="combobox"`, `aria-controls`, `aria-activedescendant`,
  `aria-autocomplete="list"`).

The primitive lives at `web/src/components/DialogOverlay.tsx` and is
reusable — the dialog's own body is portal-free and just renders as
`children`.

The panel body is a two-column grid (`grid-template-columns: 55fr 45fr`).
Left column: search input, selected chips strip, section-facet chips
(top 6 by count over the current page), and a grouped keyboard-navigable
result list. Right column: live detail pane for the currently-highlighted
row — package name and one-line summary, an `Identity` block, a log-scaled
popcon bar (anchor: 100 k installs — Ubuntu Noble's rough well-installed
median — via `popconBarWidth()` at `PackageSearchDialog.tsx:145-150`),
homepage, install size, `provides` grouped by kind (`binary` / `library` /
`mimetype` / `dbus` / `python`), tags / categories / keywords, dependencies
(`depends`, `recommends`), and the long description.

Keyboard navigation on the input (`onInputKeyDown`, `PackageSearchDialog.
tsx:419-487`):

- `ArrowUp` / `ArrowDown` — cycle focus with wrap.
- `PageUp` / `PageDown` — jump ±10 with `Math.min` / `Math.max` clamps.
- `Home` / `End` — first / last visible row.
- `Enter` — toggle selection on the focused row, push the query into
  recents, leave the dialog open.
- `Cmd/Ctrl+Enter` — toggle + close.
- `ArrowRight` when the caret is at the end of the input — focus the detail
  pane (`setDetailFocused(true)`).
- `ArrowLeft` inside the detail pane — return focus to the input.

Substring highlighting is done inline via the `highlight()` helper: query
tokens are split on whitespace, regex-escaped, joined into a single
alternation, and every capture is wrapped in `<mark>` with a
`color-mix(in srgb, var(--classic-blue) 25%, transparent)` background.

Recent searches persist in
`localStorage['ict.packagesearch.recents']` (`RECENTS_KEY`), capped at
`RECENTS_CAP = 10` entries. Only queries of length ≥ 2 are cached; the
first-match dedupe keeps repeats at the top.

Shared helpers live at `web/src/components/packageSearchShared.ts`:
`normalizeArch()` (UI's `x86_64` → pkgsvc's `amd64`, etc. via `ARCH_MAP`),
`PKG_NAME_RE`, `DEBOUNCE_MS`, `SEARCH_LIMIT` (100), `GROUP_RULES`,
`groupFor()`, and a `MINISEARCH_OPTIONS` block that fixes fields
(`name`, `description`, `provides`), boosts (`name × 3`, `provides × 2`,
`description × 1`), `fuzzy: 0.2`, `prefix: true`. Both surfaces import it
so their reranking stays in lockstep.

Details prefetch on hover (`prefetchDetails`) and on focus change; results
land in `detailCacheRef` — a session-scoped `Map<string, PackageDetails>`
that clears on dialog unmount. The in-flight fetch is guarded by an
`AbortController` (`abortRef`) so rapid keystrokes stop hammering the
microservice — the newer request cancels the older one on the wire, not
just on the client-side response check.

## Design tokens and theming

Every colour, shadow and radius the SPA uses is a CSS variable declared at
`:root` and overridden inside `.dark` in `web/src/index.css`. Theme flip is
a single class toggle on the `<html>` element (`applyThemeClass()` in
`store.ts`), driven by the store's `theme` field and mirrored into
`localStorage['ict.theme']`. Because nothing paints in JavaScript against
theme values, the flip is instant and re-render-free.

The named tokens the tree relies on:

- Surfaces — `--page-background`, `--section-background`, `--input-background`.
- Text — `--title-text`, `--font-color`, `--muted-color`.
- Structure — `--border-color`, `--options-shadow`.
- Accent — `--classic-blue` (light `#0054ae`; dark shifts to `#0099ec` so it
  reads against the dark section background), `--tine-1`.
- Status — `--danger`, `--danger-fg`, `--warning`, `--success`.
- Gradients — `--linear-gradient`, `--metrics-gradient` (the Build Image
  button's fill).
- Toast pairs — `--toast-{danger,success,warning,info}-{bg,border}`.
- Typography — `--font-sans` (Manrope, closest public match to Intel One
  Display), `--font-mono` (Intel One Mono; both pulled from Google Fonts at
  the top of `index.css`).

`.dark` also shifts `color-scheme` so form-control chrome and default
scrollbars follow. A cold-load FOUC pair — an inline snippet in
`index.html` plus the module-load `applyThemeClass(initialTheme)` in
`store.ts` — makes sure the `.dark` class is on the `<html>` element
*before* React first paints.

## State management

`web/src/store.ts` is a single Zustand store with `persist` middleware.
Slices:

- `manifest: Manifest | null` — set once on boot from `api.getManifest()`.
- `selection: Selection` — Basic cascade fields (`vertical`, `sku`,
  `platform`, `os`, `kernel`, `imageType`). `setField` resets every
  downstream field on change so the cascade never leaves an invalid
  combination selected.
- `advancedYaml: string`, `advancedSeedPick: string` — Advanced tab buffer
  + seed dropdown selection.
- `interactiveDraft: InteractiveDraft | null` — Interactive tab form.
  `null` means "operator hasn't touched the tab yet"; the first edit or
  seed-load materialises it. `setInteractiveDraft` shallow-merges;
  `loadInteractiveDraft` fully replaces (used after `parseYamlToDraft`);
  `resetInteractiveDraft` clears the pair.
- `interactiveSeedPick: string` — parallel to `advancedSeedPick`.
- `theme: Theme`, `toasts: Toast[]` — theme lives here so any component can
  toggle without threading context; toasts likewise let `useToast()` push
  without a provider.

Persistence:

- `name: 'ict.store'`, `version: 1`.
- Storage: `createJSONStorage(() => localStorage)`.
- `partialize` explicitly excludes `manifest` (refetched at boot),
  `toasts` (ephemeral), and any busy flags — only `interactiveDraft`,
  `interactiveSeedPick`, `advancedYaml`, `advancedSeedPick`, and
  `selection` are persisted.

Build history is a separate concern, backed directly by `localStorage`
outside the store (`web/src/lib/buildHistory.ts`). Two keys:

- `ict.buildHistory.v1` — JSON array of `BuildHistoryEntry`, newest-first,
  capped at `MAX_ENTRIES = 50` (FIFO — 51st push evicts entry 50).
- `ict.buildHistory.selected.v1` — the currently-selected `buildId`, or
  absent when nothing is selected.

`useBuildHistory()` seeds React state synchronously from `readEntries()` /
`readSelected()` and persists on every mutation. `addEntry` dedupes by
`buildId` and re-prepends; `updateEntry` merges a patch but never lets it
overwrite the primary key; `deleteEntry` also clears `selectedBuildId` if
the deletion targets it; `clearAll` nukes both keys. Quota failures on
write are caught and `console.warn`ed — a lost history append is preferable
to a crashed tab.

## Frontend deployment

`Dockerfile.frontend` is a two-stage build. Stage one is `node:22-alpine`:
lockfile-first `npm ci --no-audit --no-fund` for reproducible installs and
Docker layer caching, then a full source copy, then `npm run build` (which
is `tsc -b && vite build` per `web/package.json`). Stage two is
`nginxinc/nginx-unprivileged:1.27-alpine`, chosen because it runs as
UID 101 and its default config listens on 8080 — no `CAP_NET_BIND_SERVICE`,
no root-owned processes in the container.

Two files land in the runtime image:

- `docker/nginx/default.conf.template` → `/etc/nginx/templates/default.conf.template`.
  The `.template` suffix triggers the base image's
  `20-envsubst-on-templates.sh` entrypoint script, which renders the file
  through `envsubst` into `/etc/nginx/conf.d/default.conf` at start.
- `/web/dist` from stage one → `/usr/share/nginx/html`.

Two env vars govern the template render:

- `BACKEND_URL` — default `backend:8080` (the sibling compose service). The
  template's `upstream backend { server ${BACKEND_URL}; keepalive 16; }` picks
  it up. Override at `docker run -e BACKEND_URL=…` or in compose.
- `NGINX_ENVSUBST_FILTER=^BACKEND_URL$` — whitelists exactly one variable so
  nginx's own `$host`, `$scheme`, `$remote_addr`, `$proxy_add_x_forwarded_for`
  in the template pass through untouched. Without the filter, `envsubst`
  would try to expand every `$…` in the file and blow up nginx's config
  parser.

The `/api/` location is deliberately tuned for the SSE build-log stream:

    location /api/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering              off;
        proxy_cache                  off;
        proxy_read_timeout           1h;
        proxy_send_timeout           1h;
        chunked_transfer_encoding    on;

        proxy_set_header Connection "";
    }

`proxy_buffering off` matters — otherwise nginx accumulates SSE bytes in
its own buffer and the browser sees the log all at once at the end, or
times out silently while the stream is still writing. `proxy_read_timeout
1h` is up from the 60 s default so a 30-minute chroot build doesn't get
502'd on an idle connection. `chunked_transfer_encoding on` keeps the
backend's per-event flush behaviour intact end-to-end. And the empty
`Connection ""` header strips any client-sent `Connection: close` so the
upstream keepalive pool actually reuses sockets.

The SPA itself is served from `/`. Hashed assets under `/assets/` get a
one-year immutable cache; the entry HTML gets `Cache-Control: no-cache` so
a rebuild reaches browsers on next reload. `try_files $uri $uri/
/index.html` on `/` is the SPA fallback — every client-side route falls
through to `index.html` and React Router (well, `readUrlState`) picks it
up from there.

A `HEALTHCHECK` hits `http://127.0.0.1:8080/` every 30 s so an orchestrator
notices a dead nginx before the frontend is publicly wedged. Nothing else
is set — the base image already provides `CMD ["nginx", "-g", "daemon
off;"]` and the entrypoint chain that renders the template.
