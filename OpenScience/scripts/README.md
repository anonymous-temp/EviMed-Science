# scripts

Repo tooling.

- `release/` — packaging and release scripts (Tauri build matrix, signing/notarization
  helpers, GitHub Release upload, `latest.json` generation).
- `dev/` — local development helpers (bootstrap, run the app, seed the demo workspace).
- `ops/` — hosted Web operations helpers for single-node deployments, including
  `OPEN_SCIENCE_DATA_DIR` backup, restore, local retention pruning, and
  disposable restore drills with optional encrypted archives. Encrypted archive
  and checksum pairs can be uploaded to and downloaded from S3-compatible object
  storage through a no-shell CLI adapter with strict URI/file validation. The
  adapter also provides a temporary write/read/integrity/delete production
  probe. A deployment smoke test covers already-running Web deployments. The monitoring
  configuration helper writes no-follow, owner-only Prometheus/Grafana/
  Alertmanager secrets and validates the generated webhook routing before the
  bundled monitoring Compose profile is started; its probe mode sends a bounded
  synthetic resolved notification to the configured receiver. The OIDC helper writes and
  validates separate owner-only provider-client and AES-GCM flow secrets for
  the OIDC Compose overlay without printing their values. The release-manifest helper
  records and verifies immutable Web/runtime image IDs, OpenCode/uv versions,
  core skill-pack content, monitoring versions, and release input digests before
  production Compose startup.
