# Web UI + Jenkins Worker-Farm Dispatch — Setup Guide

This guide walks through bringing up the ICT web UI on a fresh Ubuntu machine
so that clicking **Build Image** fans a build out to one of N Jenkins workers
in the `ict-farm/workers` fleet rather than running the image build locally.

Everything below is scoped to the **fork**
(<https://github.com/DebalGhosh/image-composer-tool>). The upstream
`open-edge-platform` repo has the local-build path only; the Jenkins-dispatch
code lives on `fork-main`.

---

## What you get

- A React + TypeScript SPA (Vite) served on `http://localhost:5173`.
- A Go HTTP API on `http://127.0.0.1:8080` that:
  - Lists `worker-*` jobs under a configured Jenkins folder.
  - Picks one free-first (random fallback) and triggers it via
    `buildWithParameters` with just `TEMPLATE_YAML` overridden.
  - Tails the build log via Jenkins' `progressiveText` and relays each line
    as an SSE `log` event to the browser.
  - Hands back artifact list on completion, each pointing at Jenkins'
    `/artifact/<relPath>` directly (browser downloads straight from
    Jenkins, no proxy).
- All Jenkins credentials stay server-side. The browser never sees the API
  token.

Architecture in one line:

```
Browser (SPA)  ─┬─►  Go API (localhost:8080)  ─►  Jenkins REST  ─►  worker-NN
                └─ SSE log stream ◄──────────────────────────────────┘
```

---

## 0. Prerequisites — fresh Ubuntu 24.04

```bash
sudo apt update
sudo apt install -y \
    git curl ca-certificates \
    build-essential \
    nodejs npm
```

Install Go 1.24+ (the tool requires it):

```bash
# Adjust the version as needed
GO_VERSION=1.24.0
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile
source ~/.profile
go version   # should print go1.24.x
```

Node.js 20+ recommended for Vite 6. If your distro's `nodejs` package is older,
use nvm or the NodeSource repository:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 1. Set up Jenkins credentials

You need an **API token** for the Jenkins user that will trigger builds.
Passwords are not accepted for API calls.

### 1.1 Pick or create the Jenkins user

Whichever account you use must have `Job/Read` and `Job/Build` on every
`ict-farm/workers/worker-*` job. Using your own login is simplest and gives
you audit trails; a shared service account (e.g. `lab_bldmstr`) is also
fine if your controller admin has already granted the right permissions.

### 1.2 Generate the API token

1. Open the Jenkins dashboard in a browser and log in.
2. Click your name in the top-right → **Security**
   (URL pattern: `${JENKINS_URL}/user/<username>/security/`).
3. Under **API Token**, click **Add new Token**.
4. Give it a memorable name — e.g. `ict-web-ui-dispatch` — so you can revoke
   it later.
5. Click **Generate** and **copy the value immediately**. Jenkins shows it
   once; if you lose it you have to revoke and regenerate.
6. Click **Save** at the bottom of the page.

If the token is ever pasted into a chat log, shell history, or a shared
file, revoke it from the same page and generate a fresh one.

### 1.3 Note the four values you'll need

| Name | What | Example |
|---|---|---|
| `JENKINS_URL` | Full controller URL, no trailing slash | `https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02` |
| `JENKINS_USER` | Jenkins login name | `debalgho` |
| `JENKINS_TOKEN` | Token from step 1.2 | *(secret, 34 hex chars)* |
| `JENKINS_WORKERS_PATH` | Folder holding the `worker-*` jobs | `ict-farm/workers` (default) |

---

## 2. Seed the worker farm on Jenkins

If the workers don't yet exist on your controller you'll get a
`no worker jobs found` error at dispatch time. To seed the fleet:

1. Create a new pipeline job on Jenkins (top-level, no folder). Any name
   works, e.g. `ict-farm/seed`.
2. Configure it as **Pipeline script from SCM**:
   - Repository: `https://github.com/intel-innersource/libraries.devops.jenkins.cac.git`
   - Branch: `ict/experimental` (while the farm is incubating; flip to
     `ict/main` once merged)
   - Script Path: `cac/gen/lin/core-os/ict-qa-templatized/workers/worker-seed/Jenkinsfile_abi.build`
3. Save and click **Build with Parameters**.
   - `WORKER_COUNT`: `10` (any 1–200; the seed clamps)
   - `DRY_RUN`: `false`
   - `TRIGGER_PARAMS_BUILD`: `true` (fires a PARAMS_ONLY warm-up on every
     freshly-created worker so the job config settles)
4. Wait for the seed to finish. Under `<BASE_FOLDER>/workers/` you should
   see `worker-01`, `worker-02`, …, `worker-N`.

Every generated worker carries the same 11-parameter surface as the
per-variant `ict-qa-templatized` jobs. The web UI only touches
`TEMPLATE_YAML`; every other parameter (NODE_LABEL, CUSTOM_WORKSPACE,
ICT_REPO, ICT_BRANCH, ICT_COMMIT, ICT_BUILD_CMD, TEMPLATIZED_BRANCH,
COCOON_SCRIPT_REPO, CLEANWS, PARAMS_ONLY) keeps its seed default.

---

## 3. Clone the fork

```bash
git clone -b fork-main https://github.com/DebalGhosh/image-composer-tool.git
cd image-composer-tool
```

The `fork-main` branch is where the Jenkins dispatch code lives. `main`
tracks upstream.

---

## 4. Handle Intel's TLS chain (only if your controller uses a public CA)

The `cje-pg-prod01.devtools.intel.com` controller uses a Sectigo/USERTrust
certificate chain. Ubuntu 24.04's default `ca-certificates` bundle *should*
include USERTrust — but on some Intel-managed images the assembled bundle at
`/etc/ssl/certs/ca-certificates.crt` is stale and does not.

**Diagnose:**

```bash
grep -c 'USERTRUST' /etc/ssl/certs/ca-certificates.crt
```

If the count is `0`, you'll hit `SSL certificate problem: unable to get local
issuer certificate` on every request to Jenkins. To fix without touching
system-wide trust, build a private bundle just for this app:

```bash
install -d -m 700 ~/.config/ict-web

cat /etc/ssl/certs/ca-certificates.crt \
    /usr/share/ca-certificates/mozilla/USERTrust_RSA_Certification_Authority.crt \
    /usr/share/ca-certificates/mozilla/Sectigo_Public_Server_Authentication_Root_R46.crt \
    > ~/.config/ict-web/ca-bundle.crt

chmod 644 ~/.config/ict-web/ca-bundle.crt
```

The Go server will pick this up via `SSL_CERT_FILE` (see step 6).

Verify with `openssl` that Jenkins verifies against the new bundle:

```bash
echo | openssl s_client -showcerts \
    -CAfile ~/.config/ict-web/ca-bundle.crt \
    -connect cje-pg-prod01.devtools.intel.com:443 \
    -servername cje-pg-prod01.devtools.intel.com 2>&1 \
    | grep 'Verify return code'
```

Expected output: `Verify return code: 0 (ok)`.

If your Jenkins controller uses a private (Intel-internal) CA instead of a
public one, use `/home/<you>/.cert/intel_full_ca_chain.pem` (or an equivalent
Intel PKI bundle) instead of the USERTrust chain above.

---

## 5. Corporate proxy (only if you have one)

Intel-managed shells typically have `https_proxy=http://proxy-dmz.intel.com:912`
in the environment. The proxy is for external traffic; Jenkins is
internal and DNS resolves directly, so the proxy must be **bypassed** for
Jenkins hosts.

Some tools honour `no_proxy=*.intel.com` correctly (Firefox, most curl
builds); others don't apply the wildcard to sub-subdomains
(`cje-pg-prod01.devtools.intel.com` is under `.devtools.intel.com`, not
`.intel.com` directly, so pattern-matching quirks bite).

Safest is to strip the proxy for this server's shell:

```bash
unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY
```

Put this in the same environment as the server (see step 6).

---

## 6. Configure the environment

Create an env file with `chmod 600` so only your UID can read it:

```bash
install -d -m 700 ~/.config/ict-web

cat > ~/.config/ict-web/env <<'EOF'
# Jenkins dispatch config for the ICT web UI.
# Do not commit. chmod 600.

# Strip the corporate proxy for internal Jenkins hosts.
unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY

# Jenkins controller.
export JENKINS_URL='https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02'
export JENKINS_USER='your-jenkins-login'
export JENKINS_TOKEN='paste-your-api-token-here'
export JENKINS_WORKERS_PATH='ict-farm/workers'   # default; override only if the folder moves

# Private CA bundle from step 4 (only needed if the system bundle was stale).
export SSL_CERT_FILE="$HOME/.config/ict-web/ca-bundle.crt"
EOF

chmod 600 ~/.config/ict-web/env
```

Then in any shell you want to run the server from:

```bash
. ~/.config/ict-web/env
```

`ps` will not show the token because it's an env var, not a command-line
argument. The API token also never appears in server logs.

### Sanity check the token + fleet

```bash
curl -sS -u "$JENKINS_USER:$JENKINS_TOKEN" \
    "$JENKINS_URL/api/json?tree=nodeName"
```

Expected: JSON like `{"_class":"hudson.model.Hudson","nodeName":""}`. If you
get HTML back, the SSO proxy stripped Basic auth or the URL/token is wrong.

```bash
curl -sS -u "$JENKINS_USER:$JENKINS_TOKEN" \
    "$JENKINS_URL/job/ict-farm/job/workers/api/json?tree=jobs%5Bname%2Ccolor%5D"
```

Expected: a JSON `jobs[]` array with 10 entries, one per worker, each with
a `color` field (`blue` = idle, ends in `_anime` while a build runs).

---

## 7. Build the Go binary

```bash
go build -o ./build/image-composer-tool ./cmd/image-composer-tool
```

Confirm the Jenkins flags are wired:

```bash
./build/image-composer-tool serve --help | grep jenkins
```

You should see `--jenkins-url`, `--jenkins-user`, `--jenkins-token`, and
`--jenkins-workers-path`, each carrying its env-var fallback.

---

## 8. Start the API server

```bash
. ~/.config/ict-web/env
./build/image-composer-tool serve --host 127.0.0.1 --port 8080
```

Expected log output:

```
INFO   Using configuration from: image-composer-tool.yml
INFO   no embedded web UI build; serve the UI via `cd web && npm run dev`
INFO   ICT web UI API listening on 127.0.0.1:8080
```

To run it as a background process for testing:

```bash
./build/image-composer-tool serve --host 127.0.0.1 > /tmp/ict-serve.log 2>&1 &
disown
tail -f /tmp/ict-serve.log
```

### Smoke test the endpoints

```bash
# Manifest — should return the vertical/SKU/platform matrix.
curl -sS --noproxy '*' http://127.0.0.1:8080/api/v1/manifest | head -c 200

# Jenkins dispatch — empty YAML should return HTTP 400 EMPTY_YAML, proving
# the endpoint is wired and credentials are picked up.
curl -sS --noproxy '*' -X POST -H 'Content-Type: application/json' \
    -d '{"yaml":""}' \
    http://127.0.0.1:8080/api/v1/jenkins/dispatch
```

Expected: `{"error":{"code":"EMPTY_YAML","message":"template YAML is empty"}}`.

If instead you get `{"error":{"code":"JENKINS_DISABLED", ...}}` it means one
of `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN` didn't reach the server
process — re-source the env file.

---

## 9. Start the web UI (Vite dev server)

In a separate shell:

```bash
cd web
npm ci           # first time only; matches package-lock.json exactly
npm run dev
```

Expected output:

```
VITE v6.x.x  ready in 300 ms
➜  Local:   http://localhost:5173/
```

The dev server proxies `/api/v1/*` to `127.0.0.1:8080` — nothing to
configure. Open <http://localhost:5173> in your browser.

### End-to-end test

1. On the **Basic** tab, complete the cascading selectors
   (vertical → SKU → platform → OS → image type).
2. Click **Build Image**.
3. The tab switches to Build Image and you should see, in order:
   - A worker chip next to *Building…* — e.g. `worker-04`.
   - A `↗ View in Jenkins` link in the top-right of the Build Status card
     (opens the running Jenkins build in a new tab).
   - The log panel filling with `[dispatcher]` lines, then Jenkins'
     progressiveText output at ~1-second cadence.
   - Once Jenkins assigns a build number, the chip shows `worker-04 · #12`
     and the "View in Jenkins" link becomes the specific build URL.
4. When the build finishes, the *Artifacts* card renders each output with a
   clickable filename pointing directly at Jenkins' `/artifact/<relPath>`
   endpoint. Clicking downloads from Jenkins (a new tab), not through the
   local server.

The **Advanced** tab works the same way, with pasted raw YAML instead of
the cascading selectors.

---

## 10. Production/permanent setup

For a persistent deployment on the same box, run the API under systemd:

```ini
# /etc/systemd/system/ict-web.service
[Unit]
Description=ICT web UI backend (Jenkins dispatch)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<your-user>
EnvironmentFile=/home/<your-user>/.config/ict-web/env
ExecStart=/home/<your-user>/image-composer-tool/build/image-composer-tool serve --host 127.0.0.1 --port 8080
Restart=on-failure
RestartSec=5s

# Don't leak the token to journalctl.
StandardOutput=append:/var/log/ict-web.log
StandardError=append:/var/log/ict-web.log

[Install]
WantedBy=multi-user.target
```

Note: systemd's `EnvironmentFile=` does **not** run shell — it just parses
`KEY=VALUE` lines. Remove the `unset` and `export` prefixes from
`~/.config/ict-web/env` if you point systemd at it, or write a wrapper
script that sources the file then execs the binary.

For the frontend, `npm run build` under `web/` produces `web/dist/`. That
directory can be served by any static-file server, or embedded into the Go
binary via `internal/webui/embed.go` at build time.

---

## Troubleshooting

### `SSL certificate problem: unable to get local issuer certificate`

The system CA bundle is missing the root your Jenkins controller chains up
to. Follow **step 4** to build a private trust bundle and export
`SSL_CERT_FILE`. Go's `crypto/tls` honours `SSL_CERT_FILE` directly.

### Requests to Jenkins go through the corporate proxy and 403

The proxy sits in front of external hosts only. Follow **step 5** to strip
`http_proxy` / `https_proxy` in the server's shell. Even if `no_proxy`
includes `*.intel.com`, some libraries don't apply the wildcard to
sub-subdomains — the safe move is to unset the proxy entirely for this
process.

### `bind: address already in use` when starting the server

Another instance of `ict-serve` (or any process) already owns port 8080.

```bash
ss -tlnp | grep ':8080'
# Note the pid, then:
kill <pid>
```

If it's a stale build of the same tool, killing it and re-running is safe.
If it's an unrelated service, choose a different port with
`--port 8081` (and update `web/vite.config.ts`'s proxy target).

### Dispatch returns `JENKINS_DISABLED` 503

The server started without one of `JENKINS_URL` / `JENKINS_USER` /
`JENKINS_TOKEN` set. Re-source `~/.config/ict-web/env` and restart the
server. Verify with:

```bash
env | grep JENKINS_
```

### Dispatch returns `NO_WORKERS`

Either the workers path is wrong (default `ict-farm/workers`; override
with `JENKINS_WORKERS_PATH`) or your token's user lacks `Job/Read` on the
worker jobs. Re-run the fleet-listing curl from step 6 with the same
credentials to isolate.

### Log stream stalls or `[dispatcher] log stream error`

Jenkins' `progressiveText` needs `X-Text-Size` and `X-More-Data` headers to
work. If a reverse proxy strips one, the server falls back to
`offset + len(body)` and keeps going. A handful of consecutive HTTP
errors (network blips, brief 502s from a proxy) is tolerated before the
build is marked failed. Persistent failures usually mean:

- The proxy in front of Jenkins is stripping `X-*` response headers
  (in which case the fallback is doing the right thing and the log will
  simply not de-duplicate offsets on retries).
- The auth token expired mid-build — regenerate and restart the server.

### `SSO login page` response instead of JSON

The Intel SSO proxy is stripping Basic auth headers. Try:

- A `curl -sS -u "$JENKINS_USER:$JENKINS_TOKEN" "$JENKINS_URL/api/json"`
  from the same shell that starts the server, to check whether curl sees
  the same problem. If it does, the fix is at the reverse proxy layer
  (not solvable from this codebase).
- Occasionally a browser session cookie is needed alongside Basic auth on
  proxied Jenkins. If curl works but the Go server sees HTML, the issue is
  in the `net/http` transport's cookie handling — file a bug or extend
  `jenkinsClient.http` with a `net/http/cookiejar` before the first call.

### Browser shows "connection refused" on `localhost:5173`

The Vite dev server isn't running. In another shell: `cd web && npm run dev`.
The API on `:8080` is separate — both need to be up for the UI to work.

### Artifact download links open a Jenkins login page

The link points at Jenkins directly, not through the local server. If your
browser isn't already authenticated to Jenkins, log in once in the same
browser session and click the link again. This is by design so the browser
streams straight from Jenkins without proxying multi-GB image files
through the local API.

---

## Security notes

- The API token is treated as a password. It's held only in the server
  process's memory + the on-disk env file (`chmod 600`). It never appears
  in the browser, in HTTP responses, in `command` strings sent to the UI,
  or in any log line the server emits.
- The Go server binds to `127.0.0.1` by default. Do **not** bind to
  `0.0.0.0` unless the host has an authentication layer in front — the
  API can trigger builds on your Jenkins account.
- If the token is ever exposed (pasted in a chat, committed to a repo,
  logged), revoke it immediately from the Jenkins **Security** page and
  generate a fresh one.
- CSRF crumb is intentionally not fetched. Jenkins API tokens are exempt
  from CSRF protection per the [official CSRF Protection
  documentation](https://www.jenkins.io/doc/book/security/csrf-protection/).
  If your controller admin has disabled the exemption, the server will
  need a small addition — the `jenkinsClient` in `internal/api/jenkins.go`
  has a stub commented for this eventuality.

---

## What's happening under the hood

For maintainers, a quick trace of a single **Build Image** click:

1. Browser POSTs `/api/v1/jenkins/dispatch` with `{yaml: "..."}` to the
   local Go server.
2. Server calls
   `GET ${JENKINS_URL}/job/ict-farm/job/workers/api/json?tree=jobs[name,color]`
   to enumerate `worker-*` jobs.
3. Filters to workers whose `color` doesn't end in `_anime` (idle). If any
   are idle, picks one uniformly at random; else picks uniformly at random
   from the full list.
4. Calls
   `POST ${JENKINS_URL}/job/ict-farm/job/workers/job/<worker>/buildWithParameters`
   with `TEMPLATE_YAML=<url-encoded YAML>` as the only field. Every other
   configured parameter keeps its Jenkins-declared default.
5. Reads the `Location` response header (queue item URL) and returns a
   `buildAccepted` JSON `{buildId, status, logsUrl}` to the browser. The
   `buildId` is a locally-minted UUID keyed to the shared build tracker.
6. In a background goroutine: polls the queue item every second until
   Jenkins assigns a build number, then tails
   `${buildUrl}/logText/progressiveText?start=<offset>` using the
   `X-Text-Size` (next offset) and `X-More-Data` (stream open) response
   headers, appending each line to the build's in-memory log buffer.
7. When `X-More-Data` is absent (log writer closed), reads the build's
   final `result` (`SUCCESS` / `FAILURE` / …) and its `artifacts[]` list,
   maps each into `{name, type, url}` where `url` is
   `${buildUrl}/artifact/<url-escaped-relPath>`, and closes the build's
   `done` channel.
8. The browser's `EventSource` on `/api/v1/builds/{buildId}/logs` — a
   generic SSE handler that has always driven the local build path — has
   been receiving `log` events all along. It receives a final `complete`
   or `error` event with `{status, artifacts}` and renders the artifact
   table.

Nothing about steps 6–8 is Jenkins-specific from the browser's point of
view; the SSE contract is identical to the local build path. The only new
data the UI reads is the optional `jenkins` block returned from
`/api/v1/builds/{buildId}/details`, which drives the worker chip and the
"View in Jenkins" link.
