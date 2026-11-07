# Current execution evidence

Current source SHA-256: `f8354d1289ee32fc6a6a245bf915ba70b131be930b05f96b993ec76e5d90f782`.

See [DELIVERY.zh-CN.md](DELIVERY.zh-CN.md) and [machine summary](evidence/2026-11-07-delivery-summary.json).

- `artifacts/delivery/report.json`: all 12 checks passed; source unchanged.
- `artifacts/delivery/tests.json`: 26 files, 125 passed / 7 explicitly skipped.
- `artifacts/delivery/desktop-tests.json`: 6/6 passed, separately serialized.
- `artifacts/delivery/desktop-demo.log`: succeeded; exact Unicode file read-back true.
- `artifacts/clean-install/report.json`: new cached npm ci directory, build and real Chromium demo, same source hash.
- `artifacts/console.png`: actual React rendering, visually inspected.
- `docs/evidence/2026-11-07-context-comparison.json`: 9 paired live observations, payload only.
- `docs/evidence/2026-11-07-controller-comparison.json`: full/projected scripted real controllers, 4/4 success, fees null.
- `artifacts/delivery/real-model-not-run.json`: no model/key; not_run, never passed.
- `artifacts/delivery/docker-info.txt`: daemon unavailable; no build claim.

Earlier attempts are preserved and superseded, including initial Automation timeout, shared-focus interruption and the legacy CLI exit-0 error. The final success uses one new common source fingerprint; historical successes do not establish current results.
