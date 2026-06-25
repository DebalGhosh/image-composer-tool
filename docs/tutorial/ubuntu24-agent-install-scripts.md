# Ubuntu 24 agent install scripts — package and step coverage

This document lists what **`agent-install.sh`** (Intel) and **`agent-install-nvidia.sh`**
(NVIDIA) **request on the device after boot**, and what they **do not** install.

Scripts are bundled on sample template
[`image-templates/ubuntu24-x86_64-agent.yml`](../../image-templates/ubuntu24-x86_64-agent.yml)
under `/opt/agent/`. They are **not** run during image compose unless you add separate
build-time actions.

**Run one stack per node** unless you deliberately plan overlapping GPU drivers and repos.

| Script | Path on image | Log | Stamp directory |
|--------|---------------|-----|-----------------|
| Intel | `/opt/agent/agent-install.sh` | `/var/log/agent-install.log` | `/var/lib/agent-install/done/` |
| NVIDIA | `/opt/agent/agent-install-nvidia.sh` | `/var/log/agent-install-nvidia.log` | `/var/lib/agent-install-nvidia/done/` |

**Behavior:** `apt-get update` and `apt-get install` run **every** time. Repo setup,
remote installers, and pip venv steps run **once** (stamp files) unless `FORCE=1`.

---

## At a glance

| Category | Intel script | NVIDIA script |
|----------|--------------|---------------|
| Intel OpenVINO / oneAPI / L0 / NPU / DL Streamer | Yes (APT) | **No** |
| NVIDIA driver / CUDA / cuDNN / NCCL | **No** | Yes (APT, toggles) |
| NVIDIA Container Toolkit | **No** | Yes (default on) |
| Hermes (Agent OS) | Yes (default on) | Yes (default on) |
| OpenClaw (Agent OS) | Yes (default on) | Yes (default on; see NemoClaw) |
| SuperClaw | Optional edge binary only (`INSTALL_SUPERCLAW_CTL=1`) | **No** |
| NemoClaw (Agent OS) | **No** | Optional (`INSTALL_NEMOCLAW=1`) |
| Shared pip frameworks (venv) | Yes | Yes (separate venv path) |
| PyTorch (CUDA wheels) | **No** | Yes (default on) |
| vLLM | **No** | Optional (`INSTALL_VLLM=1`) |

---

## Shared — both scripts

### APT (every run)

| Debian package | Intel | NVIDIA |
|----------------|:-----:|:------:|
| `ca-certificates` | Yes | Yes |
| `curl` | Yes | Yes |
| `wget` | Yes | Yes |
| `gnupg` | Yes | Yes |
| `apt-transport-https` | Yes | Yes |
| `python3` | Yes | Yes |
| `python3-pip` | Yes | Yes |
| `python3-venv` | Yes | Yes |

### Custom steps (run-once unless `FORCE=1`)

| Step ID | Default | Intel | NVIDIA | Notes |
|---------|---------|:-----:|:------:|-------|
| `hermes-agent` | On (`INSTALL_HERMES=1`) | Yes | Yes | `curl \| bash` Hermes installer |
| `openclaw-agent` | On (`INSTALL_OPENCLAW=1`) | Yes | Yes* | `openclaw.ai/install.sh --no-onboard` |
| `agent-python-venv` / `agent-python-venv-nvidia` | Always | Yes | Yes | Creates venv + pip packages below |

\*On NVIDIA, host OpenClaw is **skipped** when `INSTALL_NEMOCLAW=1` unless
`INSTALL_HOST_OPENCLAW_WITH_NEMOCLAW=1`.

### Pip (run-once, in venv)

| Python package | Intel venv | NVIDIA venv |
|----------------|------------|-------------|
| `autogen-agentchat` | `/opt/agent/venv` | `/opt/agent/venv-nvidia` |
| `crewai` | Yes | Yes |
| `langgraph` | Yes | Yes |
| `openai` | Yes | Yes |
| `openai-agents` | Yes | Yes |

Remote installers (Hermes, OpenClaw, NemoClaw) may install **additional** packages
(Node.js, CLI tools, etc.) that are **not** listed in the script `PACKAGES` array.

---

## Intel only — `agent-install.sh`

### APT repositories (run-once: `intel-apt-repos`)

| Source | Purpose |
|--------|---------|
| `https://apt.repos.intel.com/openvino/2025` | OpenVINO |
| `https://apt.repos.intel.com/oneapi` | oneAPI runtime |
| `https://apt.repos.intel.com/edgeai/dlstreamer/ubuntu24` | DL Streamer |

### APT packages (every run, after repos)

| Debian package | Role |
|----------------|------|
| `openvino_2025.3.0.19807` | OpenVINO runtime (pinned version) |
| `intel-oneapi-runtime-compilers_2025.3.3-30` | oneAPI compilers runtime |
| `intel-oneapi-runtime-compilers-common_2025.3.3-30` | oneAPI compilers common |
| `intel-oneapi-runtime-opencl_2025.3.3-30` | oneAPI OpenCL runtime |
| `libze1` | Level Zero |
| `libze-intel-gpu1` | Intel GPU Level Zero |
| `intel-level-zero-npu` | NPU Level Zero |
| `intel-driver-compiler-npu` | NPU driver compiler |
| `xpu-smi` | Intel XPU management |
| `intel-dlstreamer_2025.2.0` | DL Streamer (pinned) |
| `podman` | OCI containers (rootless-friendly) |

### Optional custom steps

| Step ID | Env | Default | What it installs |
|---------|-----|---------|------------------|
| `superclaw-ctl-edge` | `INSTALL_SUPERCLAW_CTL=1` | **Off** | `superclaw-ctl` binary → `/opt/superclaw`, symlink `/usr/local/bin/superclaw-ctl` |

### Not requested by the Intel script

| Item | Reason |
|------|--------|
| NVIDIA driver, CUDA, cuDNN, NCCL, Container Toolkit | Use `agent-install-nvidia.sh` |
| NemoClaw / OpenShell stack | NVIDIA-only; use NVIDIA script with `INSTALL_NEMOCLAW=1` |
| SuperClaw Windows desktop app | Not supported on bare Ubuntu; Intel ships Windows/WSL product |
| Full SuperClaw edge deployment | Only optional `superclaw-ctl` binary; models/services per Intel USER-GUIDE |
| PyTorch, vLLM, TensorRT-LLM, SGLang | Not in Intel script |
| OpenClaw onboarding / systemd daemon | Install stops at `--no-onboard`; run `openclaw onboard` manually |
| `docker.io` | Not installed (Intel uses `podman` in `PACKAGES`) |

---

## NVIDIA only — `agent-install-nvidia.sh`

### APT / repo setup (run-once)

| Step ID | What it does |
|---------|----------------|
| `nvidia-cuda-keyring` | Installs NVIDIA `cuda-keyring` deb (`ubuntu2404` / `x86_64` by default) |
| `nvidia-container-toolkit-repo` | Adds libnvidia-container apt source (if `INSTALL_CONTAINER_TOOLKIT=1`) |

### APT packages (every run)

**Always in base `PACKAGES`:**

| Debian package | Default name | Notes |
|----------------|--------------|-------|
| `nvidia-driver-*` | `nvidia-driver-550-open` | Override: `NVIDIA_DRIVER_PACKAGE` |

**Appended when toggles are on (defaults in parentheses):**

| Toggle | Default | Packages |
|--------|---------|----------|
| `INSTALL_CUDA_TOOLKIT` | `1` | `cuda-toolkit-12-8` (override: `CUDA_META_PACKAGE`) |
| `INSTALL_CUDNN` | `1` | `libcudnn9-cuda-12`, `libcudnn9-dev-cuda-12` |
| `INSTALL_NCCL` | `1` | `libnccl2`, `libnccl-dev` |
| `INSTALL_CONTAINER_TOOLKIT` | `1` | `nvidia-container-toolkit` |
| `INSTALL_NEMOCLAW` | `0` | `docker.io` (only when NemoClaw enabled) |

### Post-APT configuration

| Action | When |
|--------|------|
| `nvidia-ctk runtime configure --runtime=containerd` | Container toolkit installed (best-effort if containerd absent) |
| `systemctl enable --now docker` | `INSTALL_NEMOCLAW=1` |

### Optional custom / pip steps

| Step ID | Env | Default | What it installs |
|---------|-----|---------|------------------|
| `nemoclaw-stack` | `INSTALL_NEMOCLAW=1` | **Off** | NVIDIA NemoClaw installer (`nemoclaw.sh` + third-party accept flags) |
| `pytorch-cuda-venv` | `INSTALL_PYTORCH_CUDA=1` | **On** | `torch`, `torchvision`, `torchaudio` (cu124 index) |
| `vllm-pip` | `INSTALL_VLLM=1` | **Off** | `vllm` |

### Not requested by the NVIDIA script

| Item | Reason |
|------|--------|
| Intel OpenVINO, oneAPI, Level Zero, NPU, DL Streamer, `xpu-smi` | Use `agent-install.sh` |
| `podman` | Not in NVIDIA `PACKAGES` (Docker only when NemoClaw enabled) |
| SuperClaw / `superclaw-ctl` | Intel product path |
| TensorRT-LLM | No public one-line install in script; use NGC / vendor docs |
| SGLang | Not in either script |
| NemoClaw full non-interactive onboarding | Script installs CLI/stack with accept flags; provider/onboarding may still need manual env (see NVIDIA NemoClaw docs) |
| OpenClaw onboard/daemon | Same as Intel: `--no-onboard` only unless you run onboarding later |
| Hermes / OpenClaw / NemoClaw when toggled off | Set `INSTALL_HERMES=0`, `INSTALL_OPENCLAW=0`, or leave `INSTALL_NEMOCLAW=0` |

---

## Image build vs post-boot install

The sample agent template installs **only** a minimal edge set at **compose** time
(`ubuntu-minimal`, SSH, `curl`, etc.) and copies both scripts to `/opt/agent/`.
It does **not** install OpenVINO, CUDA, or agent OS layers during compose.

Optional template `packageRepositories` entries point at Intel OpenVINO and DL Streamer
URLs for **future** template `packages:` use; the current template does **not** list
those deb names in `systemConfig.packages`.

---

## Environment quick reference

### Intel (`agent-install.sh`)

| Variable | Default | Effect |
|----------|---------|--------|
| `INSTALL_HERMES` | `1` | Hermes curl installer |
| `INSTALL_OPENCLAW` | `1` | OpenClaw installer (`--no-onboard`) |
| `INSTALL_SUPERCLAW_CTL` | `0` | SuperClaw edge `superclaw-ctl` tarball |
| `OPENCLAW_INSTALL_URL` | `https://openclaw.ai/install.sh` | OpenClaw bootstrap URL |
| `SUPERCLAW_CTL_URL` | Intel AI Builder tarball URL | SuperClaw ctl download |
| `SUPERCLAW_CTL_PREFIX` | `/opt/superclaw` | Install prefix |
| `FORCE` | `0` | Re-run stamped custom steps |

### NVIDIA (`agent-install-nvidia.sh`)

| Variable | Default | Effect |
|----------|---------|--------|
| `NVIDIA_DRIVER_PACKAGE` | `nvidia-driver-550-open` | Driver deb |
| `CUDA_META_PACKAGE` | `cuda-toolkit-12-8` | CUDA toolkit meta |
| `INSTALL_CUDA_TOOLKIT` | `1` | CUDA toolkit deb |
| `INSTALL_CUDNN` | `1` | cuDNN debs |
| `INSTALL_NCCL` | `1` | NCCL debs |
| `INSTALL_CONTAINER_TOOLKIT` | `1` | Container toolkit + repo step |
| `INSTALL_PYTORCH_CUDA` | `1` | PyTorch in venv |
| `INSTALL_VLLM` | `0` | vLLM in venv |
| `INSTALL_HERMES` | `1` | Hermes |
| `INSTALL_OPENCLAW` | `1` | Host OpenClaw |
| `INSTALL_NEMOCLAW` | `0` | NemoClaw + `docker.io` |
| `INSTALL_HOST_OPENCLAW_WITH_NEMOCLAW` | `0` | Host OpenClaw when NemoClaw=1 |
| `NEMOCLAW_INSTALL_URL` | `https://www.nvidia.com/nemoclaw.sh` | NemoClaw bootstrap |
| `FORCE` | `0` | Re-run stamped steps |

---

## Source of truth

Package names and toggles are defined in:

- [`config/osv/ubuntu/ubuntu24/imageconfigs/additionalfiles/agent-install.sh`](../../config/osv/ubuntu/ubuntu24/imageconfigs/additionalfiles/agent-install.sh)
- [`config/osv/ubuntu/ubuntu24/imageconfigs/additionalfiles/agent-install-nvidia.sh`](../../config/osv/ubuntu/ubuntu24/imageconfigs/additionalfiles/agent-install-nvidia.sh)

When the scripts change, update this document in the same change set.
