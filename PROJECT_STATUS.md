# Phase 1 + Phase 2 development status

Last updated: 2026-08-27 10:45 (Asia/Shanghai)

## Safety gates

- Before editing, the current task owner was verified through the authenticated
  loopback control plane as enabled and connected with `planType=pro` and
  `planLabel=Pro 20x`.
- No repository-specific `AGENTS.md` exists under the repository or its parent
  project directory. Architecture, security, compatibility, smoke-test, update
  automation, contributing, and existing test documentation were reviewed.
- The official ChatGPT app and installed Router remained read-only. No push,
  publish, installed-app replacement, update-guard execution, or OAuth copying
  was performed.

## Implementation complete

- State v2 adds independent `preferredAccountId` and per-thread routing policy;
  v1 migration retains every existing thread owner unchanged.
- New requests support `preferred`, `auto`, and `manual_locked`. Ordinary tasks
  prefer connected/enabled Pro 20x; disconnected, disabled, and depleted
  accounts are excluded. Manual/plugin threads do not silently migrate.
- `codexMuxRouting` is composer-local and request-local, then removed before the
  official strict app-server schema. Send/submit capture is keyed by `Document`
  and consumed once, so it cannot cross windows. A manual choice invalidates an
  earlier account-agnostic official thread prewarm before the real request.
  Route owner and reason are persisted and surfaced per thread.
- The new-task UI exposes only Primary / Pro 20x mouse choices using WeakMaps,
  so separate windows/composers cannot share manual selection state.
- Explicit `plugin://` selections receive account-scoped preflight. Unknown,
  unauthorized, or conflicting status blocks before model execution. No natural
  language prediction, OAuth copying, connector-account switching, automatic
  plugin migration, or write retry was added.
- Plugin status uses parallel RPC refresh, a 1.8-second foreground hard bound,
  background completion, 30-second in-memory TTL, and cache reuse. Cold ordinary
  tasks never trigger plugin network I/O. Badges explicitly do not claim matching
  workspace, page, or channel identity.
- Generic connector `quota` and `rate limit` text no longer triggers ChatGPT
  subscription-depletion failover.
- Temporary E2E builds can use isolated control ports and Electron profiles;
  production defaults are unchanged. Signing output no longer prints the full
  signing identity.

## Verification ledger

- Full `npm run check`: Go unit/integration tests and vet; JavaScript syntax,
  two-document/per-request isolation, outside-form Send binding, and manual
  prewarm invalidation; Python anchor/update tests; native launcher syntax;
  shell syntax.
- State coverage: v1-to-v2 migration, preferred/manual persistence, existing
  owner preservation, disconnected/disabled/depleted filtering.
- Routing coverage: private marker stripping, strict schema compatibility,
  manual lock stop, plugin-thread stop, generic plugin quota misclassification.
- Plugin coverage: exact marker only, connected/unauthorized/conflict
  reconciliation, cold/no-network, successful cache hit, background cache warm,
  1.8-second timeout, and preflight blocking.
- Renderer patch: every expected anchor was unique on official build `7119`;
  the complete temporary build and independent signature chain passed. Build
  `7119` is now recorded with its verified ASAR fingerprint.
- Real isolated desktop UI acceptance through two native windows: Primary /
  Pro 20x choices and account plugin badges rendered; default submission routed
  to Pro 20x; Primary and Pro 20x manual submissions each persisted the expected
  `manual_locked` owner; original thread owners were unchanged.
- Real two-account read-only E2E through the same final signed mux binary:
  ordinary ephemeral `thread/start` routed to Pro 20x with the persisted reason;
  a real cached connector conflict blocked before model execution; a Primary
  `google_drive.get_profile` read-only connector call returned successfully;
  test-only depleted quota preview stopped a manual thread without migration.
- `npm run release:check`, `git diff --check`, and strict deep code-signature
  verification for both temporary app bundles passed.

## Measured paths (this machine, real accounts)

- Ordinary cold `thread/start`: 2544.0 ms, including live two-account quota
  snapshots; final owner Pro 20x.
- Plugin cold cache/no-refresh: 0.8 ms, returned safe `unknown` without network
  connector preflight.
- Plugin foreground hard timeout: 1802.1 ms, returned safe `unknown` while the
  read-only refresh continued in the background.
- Plugin cache hit after background refresh: 0.6 ms.
- Cached real conflict preflight: 0.2 ms and blocked before model execution.
- Primary read-only connector call: 2541.9 ms end to end.

## Artifacts and remaining risks

- Final temporary app: `/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Phase12.app`.
- Final temporary helper: `/tmp/csr-phase12-ui-final15.JeOgHq/Codex Subscription Router Computer Use.app`.
- Desktop evidence: `/tmp/csr-phase12-ui-final15.JeOgHq/acceptance-evidence`.
- Signed mux result: `/tmp/csr-phase12-ui-final15.JeOgHq/mux-acceptance.json`.
- The manual quota exhaustion E2E used the authenticated, test-only deterministic
  preview rather than consuming a live subscription quota. Physical account
  disconnection is covered by unit/integration tests, not by logging out a real
  account during this run.
- One upstream native New Window error page occurred during earlier retries; the
  final isolated run completed with two real windows. The acceptance bridge has
  bounded recovery for that upstream condition.
- Connector identity remains intentionally account-level only; matching
  workspace/page/channel identity is deferred beyond Phase 2.
- No installation, push, or release has been performed. Await user acceptance.
