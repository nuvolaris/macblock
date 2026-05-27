FROM nvidia/cuda:12.4.1-base-ubuntu22.04

ARG TARGETARCH
ARG BUN_VERSION=1.2.15
ARG KUBECTL_VERSION=v1.30.6

LABEL org.opencontainers.image.title="Nuvolaris MacBlock"
LABEL org.opencontainers.image.description="Bestia/Nuvolaris GPU authorization watchdog runtime"
LABEL org.opencontainers.image.source="https://github.com/nuvolaris/macblock"

ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip bash \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    ARCH="${TARGETARCH:-$(uname -m)}"; \
    case "${ARCH}" in \
      amd64|x86_64) BUN_ARCH=x64; KUBECTL_ARCH=amd64 ;; \
      arm64|aarch64) BUN_ARCH=aarch64; KUBECTL_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${ARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip \
    && mkdir -p /opt/bun/bin \
    && unzip /tmp/bun.zip -d /tmp \
    && cp "/tmp/bun-linux-${BUN_ARCH}/bun" /opt/bun/bin/bun \
    && chmod 0755 /opt/bun/bin/bun \
    && rm -rf /tmp/bun.zip "/tmp/bun-linux-${BUN_ARCH}" \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" -o /usr/local/bin/kubectl \
    && chmod 0755 /usr/local/bin/kubectl

WORKDIR /opt/bestia/macblock

COPY bestia-macblock.ts /opt/bestia/macblock/bestia-macblock.ts

CMD ["bun", "/opt/bestia/macblock/bestia-macblock.ts", "watchdog-loop"]
