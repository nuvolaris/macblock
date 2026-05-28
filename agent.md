# MacBlock Agent Log

## Session Recap (2026-05-28, project spec migration)
- Promoted MacBlock to a standalone project shape inside the `nuvolaris/macblock`
  subrepo by moving the canonical product spec to `spec.md` and the architecture
  diagram to `spec.svg`.
- Kept `bestia-installer` as the parent repository and left install/config
  integration under `olaris-bestia/macblock`.

## Session Recap (2026-05-28, mock e2e validation)
- Ran an end-to-end mock authorization test against the real `nuvolaris`
  namespace using `Service/bestia-macblock-api-mock` in `kube-system` and
  watchdog image `ghcr.io/nuvolaris/macblock:0.1.0`.
- Fixed manifest rendering so development override env is propagated into the
  watchdog pod and the rendered RBAC Role uses
  `rbac.authorization.k8s.io/v1`.
- Verified allow, deny enforcement, snapshot, auto-restore, and cleanup; the
  `nuvolaris` workloads returned to their baseline replicas and Ready state.
