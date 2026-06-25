#!/bin/bash
# Install Intel agent stack + common agent frameworks on Ubuntu 24.04 (Noble).
# Target: x86_64 with Intel GPU/NPU (adjust signed-by/arch lines for aarch64).
#
# Usage:
#   sudo /opt/agent/agent-install.sh
#   sudo FORCE=1 /opt/agent/agent-install.sh   # re-run stamped custom steps
#
# Agent (OS) layer (diagram) — public install paths researched Jun 2026:
#   Hermes     — curl|bash https://hermes-agent.nousresearch.com/install.sh
#   OpenClaw   — curl|bash https://openclaw.ai/install.sh (--no-onboard for scripts)
#   SuperClaw  — Windows desktop + WSL/Docker; Linux edge = superclaw-ctl binary only
#                (intel/intel-ai-builder superclaw/superclaw-ctl/USER-GUIDE.md)
#
# Optional env (defaults):
#   INSTALL_HERMES=1  INSTALL_OPENCLAW=1  INSTALL_SUPERCLAW_CTL=0
#   OPENCLAW_INSTALL_URL=https://openclaw.ai/install.sh
#   SUPERCLAW_CTL_URL=…/superclaw-ctl-v1.0.0-linux-x86-64.tar.gz
#   SUPERCLAW_CTL_PREFIX=/opt/superclaw
#
# Rerunnable: apt-get update/install every run; custom steps once unless FORCE=1.
# Requires: network, root, writable apt/dpkg (not for immutable / without overlay).

set -euo pipefail

readonly SCRIPT_NAME="${0##*/}"
readonly LOG_TAG="agent-install"
readonly STAMP_DIR="/var/lib/agent-install/done"
readonly LOG_FILE="/var/log/agent-install.log"
readonly AGENT_VENV="/opt/agent/venv"

readonly OPENCLAW_INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.ai/install.sh}"
readonly SUPERCLAW_CTL_URL="${SUPERCLAW_CTL_URL:-https://github.com/intel/intel-ai-builder/raw/main/superclaw/superclaw-ctl/binary_build/superclaw-ctl-v1.0.0-linux-x86-64.tar.gz}"
readonly SUPERCLAW_CTL_PREFIX="${SUPERCLAW_CTL_PREFIX:-/opt/superclaw}"

INSTALL_HERMES="${INSTALL_HERMES:-1}"
INSTALL_OPENCLAW="${INSTALL_OPENCLAW:-1}"
INSTALL_SUPERCLAW_CTL="${INSTALL_SUPERCLAW_CTL:-0}"

# Debian package names (install after intel-apt-repos step).
PACKAGES=(
	ca-certificates
	curl
	wget
	gnupg
	apt-transport-https
	python3
	python3-pip
	python3-venv

	openvino_2025.3.0.19807

	intel-oneapi-runtime-compilers_2025.3.3-30
	intel-oneapi-runtime-compilers-common_2025.3.3-30
	intel-oneapi-runtime-opencl_2025.3.3-30

	libze1
	libze-intel-gpu1
	intel-level-zero-npu
	intel-driver-compiler-npu

	xpu-smi

	intel-dlstreamer_2025.2.0

	podman
)

log() {
	echo "[${LOG_TAG}] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "${LOG_FILE}"
}

require_root() {
	if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
		echo "${SCRIPT_NAME}: run as root (e.g. sudo ${SCRIPT_NAME})" >&2
		exit 1
	fi
}

run_once_step() {
	local id="$1"
	shift
	local stamp="${STAMP_DIR}/${id}"

	if [[ -f "${stamp}" && "${FORCE:-0}" != "1" ]]; then
		log "Skip step '${id}' (already done; set FORCE=1 to redo)"
		return 0
	fi

	log "Step '${id}' start"
	bash -c "$@"
	touch "${stamp}"
	log "Step '${id}' ok"
}

run_once_step_intel_apt_repos() {
	run_once_step "intel-apt-repos" '
		set -euo pipefail
		install -d -m 0755 /usr/share/keyrings

		curl -fsSL https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB \
			| gpg --dearmor -o /usr/share/keyrings/intel-sw-products.gpg

		cat >/etc/apt/sources.list.d/intel-openvino.list <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/intel-sw-products.gpg] https://apt.repos.intel.com/openvino/2025 noble main
EOF

		cat >/etc/apt/sources.list.d/intel-oneapi.list <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/intel-sw-products.gpg] https://apt.repos.intel.com/oneapi all main
EOF

		curl -fsSL https://apt.repos.intel.com/edgeai/dlstreamer/GPG-PUB-KEY-INTEL-DLS.gpg \
			| gpg --dearmor -o /usr/share/keyrings/intel-dls.gpg

		cat >/etc/apt/sources.list.d/intel-dlstreamer.list <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/intel-dls.gpg] https://apt.repos.intel.com/edgeai/dlstreamer/ubuntu24 noble main
EOF
	'
}

run_once_step_hermes() {
	run_once_step "hermes-agent" \
		'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'
}

run_once_step_openclaw() {
	run_once_step "openclaw-agent" \
		"curl -fsSL '${OPENCLAW_INSTALL_URL}' | bash -s -- --no-onboard"
}

run_once_step_superclaw_ctl() {
	run_once_step "superclaw-ctl-edge" "
		set -euo pipefail
		tmp=\$(mktemp -d)
		trap 'rm -rf \"\${tmp}\"' EXIT
		curl -fsSL '${SUPERCLAW_CTL_URL}' -o \"\${tmp}/superclaw-ctl.tgz\"
		tar -xzf \"\${tmp}/superclaw-ctl.tgz\" -C \"\${tmp}\"
		install -d -m 0755 '${SUPERCLAW_CTL_PREFIX}/bin'
		install -m 0755 \"\${tmp}/superclaw-ctl\" '${SUPERCLAW_CTL_PREFIX}/bin/superclaw-ctl'
		ln -sf '${SUPERCLAW_CTL_PREFIX}/bin/superclaw-ctl' /usr/local/bin/superclaw-ctl
	"
}

run_once_step_agent_python_venv() {
	run_once_step "agent-python-venv" "
		set -euo pipefail
		python3 -m venv '${AGENT_VENV}'
		'${AGENT_VENV}/bin/pip' install -U pip wheel
		'${AGENT_VENV}/bin/pip' install \\
			autogen-agentchat \\
			crewai \\
			langgraph \\
			openai \\
			openai-agents
	"
}

install_apt_packages() {
	if [[ ${#PACKAGES[@]} -eq 0 ]]; then
		log "No PACKAGES configured; skipping apt install"
		return 0
	fi

	export DEBIAN_FRONTEND=noninteractive
	export DEBCONF_NONINTERACTIVE_SEEN=true

	log "apt-get update"
	apt-get update -y

	log "apt-get install (${#PACKAGES[@]} packages)"
	apt-get install -y --no-install-recommends "${PACKAGES[@]}"
}

main() {
	require_root
	mkdir -p "$(dirname "${LOG_FILE}")" "${STAMP_DIR}" /opt/agent
	: >> "${LOG_FILE}"

	log "=== ${SCRIPT_NAME} start (FORCE=${FORCE:-0}) ==="

	run_once_step_intel_apt_repos
	install_apt_packages

	if [[ "${INSTALL_HERMES}" == "1" ]]; then
		run_once_step_hermes
	fi
	if [[ "${INSTALL_OPENCLAW}" == "1" ]]; then
		run_once_step_openclaw
	fi
	if [[ "${INSTALL_SUPERCLAW_CTL}" == "1" ]]; then
		run_once_step_superclaw_ctl
	fi

	run_once_step_agent_python_venv

	log "=== ${SCRIPT_NAME} complete ==="
	log "Python agent venv: ${AGENT_VENV}/bin/activate"
	if [[ "${INSTALL_OPENCLAW}" == "1" ]]; then
		log "OpenClaw: run 'openclaw onboard' (or install daemon) when ready"
	fi
	if [[ "${INSTALL_SUPERCLAW_CTL}" == "1" ]]; then
		log "SuperClaw edge: superclaw-ctl — see Intel AI Builder superclaw-ctl USER-GUIDE"
	else
		log "SuperClaw desktop (Windows/WSL): https://github.com/intel/intel-ai-builder/tree/main/superclaw"
	fi
}

main "$@"
