# Guarded update automation

`scripts/update_guard.py` separates deterministic update handling from the
version-specific engineering work required for an unknown ChatGPT Desktop
build.

## Decisions

| Decision | Meaning | Safe next action |
| --- | --- | --- |
| `current` | Installed Router matches the last recorded approved source | No-op |
| `current_unrecorded` | Installed version/build matches an approved source | Verify signatures and record the baseline |
| `supported_update` | Official ChatGPT changed to an exact approved fingerprint | Rebuild when Router is not running |
| `deferred_router_active` | A compatible update exists while Router is active | Retry later without interrupting work |
| `unsupported_update` | Version, build, or ASAR hash is unknown | Preserve Router and perform compatibility engineering |
| `blocked` | Repository, signing, verification, or another safety gate failed | Stop and report the evidence |

## Commands

Inspect without modifying the installed Router:

```sh
python3 scripts/update_guard.py check --sync-repo
```

Apply only an exact build listed in `TESTED_SOURCE_BUILDS`. The command runs the
locked dependency install, complete repository checks, guarded patcher, source
stability check, and strict code-signature verification. It defers while the
Router or Computer Use helper is active.

```sh
python3 scripts/update_guard.py apply --sync-repo --launch
```

When the user explicitly authorizes the Router to close itself, schedule a
detached handoff. The command waits 90 seconds so the current task can persist,
sends `SIGTERM` to the Router and helper, requires both to exit normally, then
runs the same guarded apply and relaunches the updated app. It never escalates
to `SIGKILL`.

```sh
python3 scripts/update_guard.py handoff --sync-repo \
  --go-bin /path/to/go/bin --launch
```

If Go is installed outside the unattended environment's `PATH`, pass its bin
directory with `--go-bin`.

After a manually verified compatibility build, record the baseline only when
the official source fingerprint is approved and the installed Router reports
the same version/build:

```sh
python3 scripts/update_guard.py record
```

Before recording an adapted build, run the signed Desktop E2E against the exact
candidate. The harness verifies UI account selection, two real routing
directions, sticky follow-up turns, the native Usage selector, and restoration
to normal mode with the private bridge closed:

```sh
python3 scripts/run_desktop_e2e.py \
  --app "$HOME/Applications/Codex Subscription Router.app" \
  --helper "$HOME/Applications/Codex Subscription Router Computer Use.app"
```

An unattended runner must treat a non-zero exit or a `result.json` status other
than `passed` as a hard stop. It must not record the new baseline, delete the
previous backup, or push compatibility metadata after an E2E failure.

State is written atomically with mode `0600` to
`~/.codex-mux/update-guard.json`. OAuth credentials and account state are not
read or copied by the guard.

## Unknown builds

Never use `--allow-untested-source` against the installed Router destination.
An engineering run may target a temporary app path, update every exact anchor
and expected replacement count, then complete the repository checks and the
signed-app smoke test. Only after that evidence exists should the new official
fingerprint be added to `TESTED_SOURCE_BUILDS` and the guarded rebuild run.
