# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and
this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- One-command installer with safe source updates, prerequisite checks, signed
  rebuilds, recoverable upgrades, and automatic launch.
- Reset-aware routing that prioritizes weekly quota at risk of expiring and
  gives a bounded boost to subscriptions with banked usage resets.
- Guarded update automation that detects official ChatGPT updates, defers while
  the Router is active, and installs only exact approved version/build/hash
  fingerprints after the full verification suite passes.
- Compatibility with official ChatGPT Desktop `26.818.61809` (build `7019`).
- Explicitly authorized detached update handoff with delayed graceful Router
  shutdown, guarded rebuild, and automatic relaunch.

## [0.1.0] - 2026-08-15

### Added

- Multi-subscription routing with quota-aware balancing and sticky threads.
- Account isolation, device-code sign-in, pooled usage, and quota failover.
- Native account menu, masked emails, plan labels, and profile photos.
- Combined Profile statistics with per-account selection.
- Account-scoped Apps and MCP connection state in Settings → Plugins.
- Per-account rate-limit reset selection and pooled depletion handling.
- Independently signed Appshots and Computer Use support.
- Fail-closed upstream compatibility checks and deepest-first nested helper signing.
- Loopback-only, token-authenticated diagnostic UI states.
- Source-only CI, draft release automation, security documentation, and smoke tests.

[Unreleased]: https://github.com/kellanxu/codex-subscription-router/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kellanxu/codex-subscription-router/releases/tag/v0.1.0
