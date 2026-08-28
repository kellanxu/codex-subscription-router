# Phase 1 + Phase 2 acceptance — 2026-08-27

This report records acceptance against official ChatGPT desktop build `7119`
using a separately signed temporary destination. It contains no access token,
email address, OAuth response, or connector result payload.

## Final artifact

- App: `/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Phase12.app`
- Computer Use helper: `/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Computer Use.app`
- UI evidence: `/tmp/csr-phase12-ui-final15.JeOgHq/acceptance-evidence`
- Signed mux result: `/tmp/csr-phase12-ui-final15.JeOgHq/mux-acceptance.json`
- Both bundles passed `codesign --verify --deep --strict`.
- The installed Router and official ChatGPT app were not modified.

## Real isolated desktop acceptance

Command:

```sh
python3 scripts/run_phase12_ui_acceptance.py \
  --app '/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Phase12.app' \
  --control-port 49153 \
  --output /tmp/csr-phase12-ui-final15.JeOgHq/acceptance-evidence
```

Passed assertions:

- a connected Primary and connected Pro 20x were present;
- isolated onboarding reached the real composer;
- new-task choices showed only Primary / Pro 20x and account plugin badges;
- ordinary default submission persisted Pro 20x with a routing reason;
- two native windows held different manual selections without leaking;
- Primary and Pro 20x submissions each persisted `manual_locked` to the chosen owner;
- plugin badges carried the workspace/page/channel scope disclaimer;
- every pre-existing thread owner remained unchanged.

## Real signed mux acceptance

Command:

```sh
python3 scripts/run_phase12_mux_acceptance.py \
  --app '/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Phase12.app' \
  --control-port 49154 \
  --output /tmp/csr-phase12-ui-final15.JeOgHq/mux-acceptance.json
```

Passed assertions:

- ordinary ephemeral `thread/start` selected Pro 20x and persisted its reason;
- cold connector status returned safe unknown without ordinary-task preflight;
- foreground connector refresh returned at the 1.8-second hard bound and later
  populated the short-lived cache;
- a real account-scoped connector conflict returned RPC `-32031` before model execution;
- Primary `google_drive.get_profile` completed as a read-only connector call;
- deterministic Primary depletion returned RPC `-32030` for a manual thread and
  did not change its owner;
- every pre-existing thread owner remained unchanged.

Measured on this machine:

| Path | Time |
| --- | ---: |
| Ordinary `thread/start` | 2544.0 ms |
| Plugin cold cache, no refresh | 0.8 ms |
| Plugin foreground hard timeout | 1802.1 ms |
| Plugin cache hit | 0.6 ms |
| Real conflict preflight block | 0.2 ms |
| Primary read-only connector | 2541.9 ms |

## Regression and release gates

- `npm run check`: passed (Go tests/vet, JS tests, Python tests, native and shell syntax).
- `npm run release:check`: passed.
- `git diff --check`: passed.
- Patch anchors were unique on build `7119`, including the official prewarm
  consumption hook needed to honor manual selection after an earlier default prewarm.
- State v1 migration, disconnected/disabled/depleted filtering, private marker
  stripping, plugin cache cold/hit/background/timeout, manual/plugin no-migration,
  and connector quota-text classification are covered by automated tests.

## Explicit limits and risks

- The quota exhaustion E2E used the authenticated test-only preview; it did not
  deliberately consume a live account quota.
- Physical logout/disconnection was not performed on the real accounts during
  acceptance; filtering is covered by unit/integration tests.
- Connector state remains account-level and does not assert identical workspace,
  page, or channel identity.
- No connector write was performed. Write auto-migration/retry prohibition is
  enforced by routing policy tests.
- An upstream native New Window error page appeared in an earlier retry. The
  final two-window run passed, and the bridge uses bounded recovery only for that page.
- No install, push, publish, or release was performed.
