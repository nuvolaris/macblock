# MacBlock Runtime Image Specification

## Scope

This repository owns the pullable runtime image for the Bestia/Nuvolaris
MacBlock watchdog.

In scope:

- `Containerfile`;
- watchdog runtime source copied into the image;
- GHCR publish workflow;
- image tags and public package visibility.

Out of scope:

- `ops bestia macblock` command surface;
- k3s AddOn manifest rendering;
- API key and installer configuration;
- development mock API.

Those installer concerns remain in `nuvolaris/olaris-bestia` under
`olaris-bestia/macblock`.

## Runtime Contract

The image must provide:

- `bun` on `PATH`;
- `kubectl` on `PATH`;
- `nvidia-smi` from a pinned NVIDIA CUDA base image;
- CA certificates and HTTPS support;
- `/opt/bestia/macblock/bestia-macblock.ts`.

Default command:

```text
bun /opt/bestia/macblock/bestia-macblock.ts watchdog-loop
```

The watchdog reads configuration from environment variables and Kubernetes
Secrets rendered by `ops bestia macblock install`.

## Architectures

Supported platforms:

```text
linux/amd64
linux/arm64
```

The build must not default `TARGETARCH` to `amd64`; local native builds and
Buildx builds must resolve Bun and kubectl downloads from the actual target
architecture.

## Images

Primary image:

```text
ghcr.io/nuvolaris/macblock:0.1.0
```

Compatibility alias:

```text
ghcr.io/nuvolaris/bestia-macblock:0.1.0
```

Both packages must be public before they are used as Bestia release defaults.

## Publish

The GitHub Actions workflow must:

- authenticate to GHCR with `packages: write`;
- build for `linux/amd64` and `linux/arm64`;
- publish the primary image tag;
- publish the compatibility alias tag.

Version `0.1.0` is the initial MacBlock runtime tag. Future runtime changes
must bump the tag before release and then update the installer default image.
