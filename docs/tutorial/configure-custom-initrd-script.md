# Configure a Custom Script in the Initrd (Early Boot)

## Overview

**Goal:** Run your own shell script **on the device during early boot** (inside the initramfs), for **Ubuntu 24.04** images with **`imageType: raw`**.

**Start from your image template:** add `systemConfig.additionalFiles` (and related entries) that point at small files you keep in the repo. The sections below first show **what to put in the YAML**; later sections explain **those files** and how to pick a boot stage.

**Full working example:** `image-templates/ubuntu24-x86_64-bb-raw.yml` and `image-templates/additionalfiles/ubuntu24-bb/`.

**Do not use** [`systemConfig.configurations`](configure-additional-actions-for-build.md) to *run* your script on the device—that only runs while the image is being built. You may still use `configurations` for `chmod` (shown below).

---

## Image template changes

Add the following under `systemConfig` in your image template YAML (for example copy `ubuntu24-x86_64-edge-raw.yml` and extend it, or start from `ubuntu24-x86_64-bb-raw.yml`).

Paths in **`local`** are relative to the **directory that contains your template file** (for a template in `image-templates/`, use `additionalfiles/...` as in the example).

```yaml
systemConfig:
  packages:
    - dracut-core
    - systemd-boot
    # … other packages, or rely on merged OS defaults from ubuntu24 raw

  additionalFiles:
    - local: additionalfiles/ubuntu24-bb/hello.conf
      final: /etc/dracut.conf.d/hello.conf
    - local: additionalfiles/ubuntu24-bb/99hello/module.sh
      final: /usr/lib/dracut/modules.d/99hello/module.sh
    - local: additionalfiles/ubuntu24-bb/99hello/hello.sh
      final: /usr/lib/dracut/modules.d/99hello/hello.sh
    - local: additionalfiles/ubuntu24-bb/99hello/hello-run.sh
      final: /usr/lib/dracut/modules.d/99hello/hello-run.sh

  configurations:
    - cmd: "chmod 755 /usr/lib/dracut/modules.d/99hello/hello.sh /usr/lib/dracut/modules.d/99hello/hello-run.sh"
```

### What each `additionalFiles` entry does

| `local` (your repo) | `final` (inside the built image) | You need to create |
|---------------------|----------------------------------|--------------------|
| `…/hello.conf` | `/etc/dracut.conf.d/hello.conf` | Enable the dracut module — see **hello.conf** below |
| `…/99hello/module.sh` | `/usr/lib/dracut/modules.d/99hello/module.sh` | Dracut module — see **module.sh** below |
| `…/99hello/hello.sh` | `/usr/lib/dracut/modules.d/99hello/hello.sh` | **Your initrd script** — see **hello.sh** below |
| `…/99hello/hello-run.sh` | `/usr/lib/dracut/modules.d/99hello/hello-run.sh` | Hook wrapper — see **hello-run.sh** below |

- **`local`:** file on the machine where you run `image-composer-tool` (must exist before build).
- **`final`:** path where ICT copies that file on the image; dracut reads these paths when building the initramfs.

Rename `ubuntu24-bb` in the paths to match your folder name. Keep the **`final`** paths as shown unless you know you need a different layout.

Optional — same script on the installed disk for manual testing (not required for initrd):

```yaml
    - local: additionalfiles/ubuntu24-bb/99hello/hello.sh
      final: /usr/local/sbin/hello.sh
```

### Field summary

| Template field | Purpose for initrd scripts |
|----------------|---------------------------|
| `additionalFiles` | **Required.** Copies your dracut config + module files into the image. |
| `configurations` | Optional `chmod` (or other one-time setup in chroot at build time). |
| `packages` | Must include **`dracut-core`** and **`systemd-boot`** (often already in ubuntu24 raw defaults). |
| `kernel.cmdline` | Optional: add `rd.debug` while debugging early boot. |

---

## Build and check

**Build the tool, install prerequisites, validate, and compose the image** using the steps in the repository [README.md](../../README.md) (Quick Start and *Compose an Image*). Use your template, for example:

`image-templates/ubuntu24-x86_64-bb-raw.yml`

Before building, run validate on that template if you use the `validate` command documented in the [Usage Guide](./usage-guide.md). If validate warns about a missing `local` file, fix the path or create the file under [Where to put files in the repo](#where-to-put-files-in-the-repo).

**On the device (after you have a raw image):**

1. Boot the flashed **raw** image.
2. Use serial console if your template sets `console=ttyS0,...` on the kernel cmdline.
3. Look for your message during early boot, or run: `dmesg | grep -i hello`

For stubborn initrd issues while debugging, add `rd.debug` to `systemConfig.kernel.cmdline` in your template.

---

## Where to put files in the repo

| Layout | `local` in template |
|--------|---------------------|
| Next to your template (typical) | `additionalfiles/<your-name>/...` under `image-templates/` |
| Ubuntu OS defaults tree | `../additionalfiles/...` from `config/osv/ubuntu/ubuntu24/imageconfigs/defaultconfigs/` |

Example tree matching the template above:

```text
image-templates/
  ubuntu24-x86_64-bb-raw.yml
  additionalfiles/ubuntu24-bb/
    hello.conf
    99hello/
      module.sh
      hello.sh
      hello-run.sh
```

---

## Supporting files (content to create)

The template only **references** files; you must create them. Module name in this example: **`hello`** (folder **`99hello`**).

| File | Role |
|------|------|
| `hello.sh` | Your script (runs in initrd). |
| `hello-run.sh` | Calls your script from a dracut hook. |
| `module.sh` | Tells dracut to pack the script and register the hook. |
| `hello.conf` | Enables the `hello` dracut module. |

### `99hello/hello.sh`

```sh
#!/bin/sh
echo "hello from initrd" >/dev/kmsg
```

Use `/dev/kmsg` or `logger` so you can see output on serial or via `dmesg`.

### `99hello/hello-run.sh`

```sh
#!/bin/sh
[ -x /usr/local/sbin/hello.sh ] && /usr/local/sbin/hello.sh
```

### `99hello/module.sh`

```sh
check() { return 0; }
depends() { echo systemd; return 0; }
install() {
    inst_simple "$moddir/hello.sh" /usr/local/sbin/hello.sh
    inst_hook initqueue/settled 99 "$moddir/hello-run.sh"
}
```

To run at a different moment in early boot, change the `inst_hook` line — see [Choosing a dracut hook stage](#choosing-a-dracut-hook-stage).

### `hello.conf`

```text
add_dracutmodules+=" hello "
```

The word `hello` must match the module name in the folder `99hello`.

Make shell scripts executable (`chmod 755`) or use the `configurations` `chmod` line in the template.

### Why the folder is named `99hello`

Dracut module directories use **`NN` + `name`** (example: `99` + `hello`):

| Part | Meaning |
|------|---------|
| **`hello`** | Module name — must match `add_dracutmodules` in `hello.conf`. |
| **`99`** | Sort order when the initramfs is **built**. Lower numbers run earlier (`01…` before `99…`). **`99`** is a common choice for custom modules so they run after distro modules. |

You may use **`00`–`99`**. If you rename the folder (e.g. `50foobar`), update `hello.conf` to `add_dracutmodules+=" foobar "`.

This **`99`** is **not** the same as the **`99`** in `inst_hook initqueue/settled 99 …`: the folder number orders **modules at build time**; the hook number orders **scripts at boot time** within one stage.

---

## Choosing a dracut hook stage

Your script runs when the hook in `module.sh` fires. Change this line to pick the stage:

```sh
inst_hook <stage> <priority> "$moddir/hello-run.sh"
```

Boot proceeds through hook stages in roughly this order:

```text
cmdline → pre-udev → pre-trigger → initqueue → pre-mount → mount → pre-pivot → cleanup → (installed OS)
```

### Hook reference

| Hook stage | When it runs (plain language) | Good for |
|------------|-------------------------------|----------|
| **`cmdline`** | Right after the kernel command line is parsed. | Very early logging, reading `root=` / `roothash=`. |
| **`pre-udev`** | Before udev handles devices. | Rare. |
| **`pre-trigger`** | Before udev “trigger” processing. | Early setup before block devices appear. |
| **`initqueue/settled`** | Devices mostly discovered; udev queue settled. **Default in the example.** | Logging, disk IDs, work needing `/dev/*` before root mount. |
| **`initqueue/finished`** | After initqueue completes. | Slightly later; still before root mount. |
| **`pre-mount`** | Just before mounting the real root filesystem. | Needs root **device** ready, not yet mounted. |
| **`mount`** | While mounting the real root. | Uncommon. |
| **`pre-pivot`** | Root mounted under `/sysroot`; last chance in initramfs. | Checks or fixes before the installed OS starts. |
| **`cleanup`** | Teardown in initramfs. | Advanced. |
| **`emergency`** | Failure / emergency path. | Diagnostics only. |

### Quick picker

| Your goal | Suggested hook |
|-----------|----------------|
| Simple “alive” log when disks exist | `initqueue/settled` |
| Need root device / LUKS / verity ready | `pre-mount` or `pre-pivot` (test on hardware) |
| Need root filesystem mounted first | `pre-pivot` |
| Run only when building the image, not on boot | [Build-time `configurations`](configure-additional-actions-for-build.md) |

**Immutable (read-only root) images:** if your script needs the verified root mounted, try **`pre-pivot`**; if only block devices matter, **`initqueue/settled`** is enough.

**Hook priority** (e.g. `99`): orders your script among **other scripts in the same stage** at boot. Lower runs first.

Examples:

```sh
inst_hook initqueue/settled 99 "$moddir/hello-run.sh"
inst_hook pre-mount 99 "$moddir/hello-run.sh"
inst_hook pre-pivot 99 "$moddir/hello-run.sh"
```

---

## Troubleshooting

| Problem | Check |
|---------|--------|
| No output on boot | All four `additionalFiles` lines in template; `hello` matches `99hello`; scripts executable. |
| Validate / build skips a file | Wrong `local` path relative to template YAML. |
| Script on disk only, not in early boot | Missing `module.sh`, `hello.conf`, or hook; copying only to `/usr/local/sbin` is not enough. |
| Wrong image type | This guide is for **`imageType: raw`**. |

---

## Related documentation

- [Custom commands at image build time](configure-additional-actions-for-build.md) — not initrd.
- [Image templates](../architecture/image-composer-tool-templates.md) — `additionalFiles` fields and merge behavior.
- [Build process](../architecture/image-composer-tool-build-process.md) — how ICT builds images.
