# Task-owner stickiness regression fix — 2026-08-27

## Reported behavior

After choosing an account for a new task, switching to another task and then
returning could make the owner control appear to reset to the default Pro 20x
account, even when the existing task belonged to Primary.

## Root cause

The injected renderer used `window.location.pathname` to distinguish a new
task from an existing task. In the packaged Electron renderer that location is
always `app://-/index.html`; Codex keeps its active route in React Router
memory. A remounted composer could therefore be initialized as a new task and
receive the preferred Pro 20x default.

## Resolution

- Bridge the native parsed React route into the injected routing UI and fail
  closed if the upstream route anchor is missing or ambiguous.
- Show mutable Primary / Pro 20x choices only on native new-task routes.
- Show a read-only persisted `Task owner` label on existing local tasks.
- Preserve a manual new-task choice across composer remounts, but clear the
  draft after entering an existing, remote, or unrelated route.
- Guard task-owner and plugin-status async responses so late responses cannot
  overwrite the currently selected task.
- Match the route bridge structurally across recorded builds 6962, 7019, and
  7119 rather than depending on one build's minified variable names.

## Verification

1. Full repository checks passed: Go tests and vet, 14 renderer tests, Python
   patch/update tests, native C syntax, shell syntax, release metadata, and
   whitespace checks.
2. A separately signed build passed deep strict signature verification for the
   Router and Computer Use helper. Historical renderer bundles from builds
   6962 and 7019, plus current build 7119, each produced exactly one route
   bridge match.
3. Real isolated desktop acceptance passed twice. The final run created
   Primary and Pro 20x tasks in one window and clicked
   Primary -> Pro 20x -> Primary. Every view showed the persisted read-only
   owner, exposed no new-task choices, and preserved all pre-existing owners.
4. Independent signed mux acceptance passed preferred Pro 20x routing, plugin
   cache and conflict handling, a Primary read-only connector call, depleted
   manual-lock no-migration, and existing-owner preservation.

Final temporary artifacts and evidence:

- App: `/tmp/csr-owner-fix-final.m7I8yg/Codex Subscription Router Final.app`
- Helper: `/tmp/csr-owner-fix-final.m7I8yg/Codex Subscription Router Computer Use.app`
- UI evidence: `/tmp/csr-owner-fix-final.m7I8yg/final-ui-evidence`
- Mux evidence: `/tmp/csr-owner-fix-final.m7I8yg/final-mux-acceptance.json`

The active installed Router was not replaced during verification, so the
current task was not interrupted. Installation should occur after the running
Router exits.
