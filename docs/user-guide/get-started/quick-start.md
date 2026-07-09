# Quick Start

This guide walks you through building your first image in three steps.

## Build and Run

```bash
# 1. Clone and build (requires Go 1.24+)
git clone https://github.com/open-edge-platform/image-composer-tool.git
cd image-composer-tool
go build -buildmode=pie -ldflags "-s -w" ./cmd/image-composer-tool

# 2. Install prerequisites
sudo apt install systemd-ukify mmdebstrap
# Or run it directly:
go run ./cmd/image-composer-tool --help

# 3. Compose an image
sudo -E ./image-composer-tool build image-templates/azl3-x86_64-edge-raw.yml
```

For full build options (Earthly, Debian package) and prerequisite details, see the
[Installation Guide](./installation.md).
