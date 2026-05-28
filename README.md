# Nuvolaris MacBlock Runtime Image

This repository builds the public MacBlock watchdog image used by Bestia v2.
Installer commands live in `nuvolaris/olaris-bestia` under
`ops bestia macblock`; this repository owns only the runtime code and container
builder for the in-cluster watchdog pod.

## Specification

- `spec.md`: product, runtime, installer integration, API contract, and
  acceptance criteria.
- `spec.svg`: architecture and flow diagram. Keep it aligned with `spec.md`
  whenever MacBlock behavior or deployment shape changes.

## Image

Primary image:

```text
ghcr.io/nuvolaris/macblock:0.1.0
```

Compatibility alias:

```text
ghcr.io/nuvolaris/bestia-macblock:0.1.0
```

The image includes:

- `bun`
- `kubectl`
- CA certificates and `curl`
- NVIDIA `nvidia-smi` from the pinned CUDA base image
- `/opt/bestia/macblock/bestia-macblock.ts`

## Local Build

```bash
docker build -t ghcr.io/nuvolaris/macblock:0.1.0 -f Containerfile .
docker run --rm ghcr.io/nuvolaris/macblock:0.1.0 bun /opt/bestia/macblock/bestia-macblock.ts --help
```

The `Containerfile` supports `linux/amd64` and `linux/arm64`.

## Publish

The GitHub workflow publishes both the primary and compatibility tags to GHCR
on pushes to `main`, version tags, and manual workflow dispatches.

The package must remain public because `ops bestia macblock install` deploys
the image directly into customer k3s clusters.
