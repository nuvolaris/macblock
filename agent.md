# MacBlock Agent Log

## Session Recap (2026-05-28, project spec migration)
- Promoted MacBlock to a standalone project shape inside the `nuvolaris/macblock`
  subrepo by moving the canonical product spec to `spec.md` and the architecture
  diagram to `spec.svg`.
- Kept `bestia-installer` as the parent repository and left install/config
  integration under `olaris-bestia/macblock`.
