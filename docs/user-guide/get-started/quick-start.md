# Quick Start

This guide walks you through building your first image in three steps. For full build options (Earthly, Debian package) and prerequisite details, see the
[Installation Guide](./installation.md). To check general prerequisites, go to [Prerequisites](./prerequisites.md), and for the practical guide on common ICT workflows, refer to [Usage Guide](./usage-guide.md).

## Build and Run

```bash
# 1. Clone and build (requires Go 1.24+)
git clone https://github.com/open-edge-platform/image-composer-tool.git
cd image-composer-tool
go build -buildmode=pie -ldflags "-s -w" ./cmd/image-composer-tool
```

Before composing an image, install the required system tools:

```bash
# 2. Install prerequisites
sudo apt install systemd-ukify mmdebstrap
# Or run it directly:
go run ./cmd/image-composer-tool --help
```

With prerequisites in place, compose an image using one of the templates:

```bash
# 3. Compose an image
sudo -E ./image-composer-tool build image-templates/azl3-x86_64-edge-raw.yml
```
