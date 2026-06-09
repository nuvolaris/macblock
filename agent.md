# MacBlock Agent Log

## Session Recap (2026-06-09, install registration and explicit policy)
- Changed MacBlock runtime semantics so install creates AddOn components and
  attempts proxy registration without mutating local workloads on registration
  failure.
- Changed watchdog failures to record state and request an explicit post-expiry
  policy instead of automatically blocking after the failure threshold.
- Added explicit policy selection for enforcement: A/remove-components,
  B/register-out-of-support, and C/block-product, with only C applying the
  strong scale-to-zero block.
- Updated the MacBlock spec, README and SVG to match the new policy flow.

## Session Recap (2026-05-28, project spec migration)
- Promoted MacBlock to a standalone project shape inside the `nuvolaris/macblock`
  subrepo by moving the canonical product spec to `spec.md` and the architecture
  diagram to `spec.svg`.
- Kept `bestia-installer` as the parent repository and left install/config
  integration under `olaris-bestia/macblock`.

## Session Recap (2026-05-28, development e2e validation)
- Ran an end-to-end development authorization test against the real `nuvolaris`
  namespace using watchdog image `ghcr.io/nuvolaris/macblock:0.1.0`.
- Fixed manifest rendering so development override env is propagated into the
  watchdog pod and the rendered RBAC Role uses
  `rbac.authorization.k8s.io/v1`.
- Verified allow, deny enforcement, snapshot, auto-restore, and cleanup; the
  `nuvolaris` workloads returned to their baseline replicas and Ready state.

## Session Recap (2026-05-28, production serial-check spec split)
- Removed server-side API ownership from the MacBlock runtime-image project spec
  and diagram.
- Pointed the server-side `POST /v1/serials_check` contract at
  `nuvolaris/ai-proxy/spec/serial-check.md`; MacBlock keeps only watchdog,
  runtime image, client contract and enforcement behavior.
