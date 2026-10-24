---
name: testbox
description: Run builds and tests on a self-hosted Testbox worker instead of the local machine. The output is JSON made for agents, with an exit code and a hint when the run fails. Use when a repo has a testbox.yml, when the user asks to verify, build, or test "on testbox" or "on a worker", when a test needs macOS, Xcode, an iOS simulator, or a browser the local machine lacks, or when the user wants to write or edit testbox.yml.
---

# Testbox

Testbox copies the local tree (uncommitted changes too) to a worker you own, runs a command there on a frozen copy, and returns the log and an exit code, with a hint when the run fails. The copy is one-way. `testbox.yml` in the repo root (or a parent) defines named profiles.

## Before you run anything

1. `testbox profiles --json` lists the profiles and the `testbox.yml` they come from. Pick the profile whose `command` matches the task. Do not guess a profile name: an unknown one exits 2 and names the real ones.
2. No `testbox.yml` (exit 2, `testbox.yml not found`)? If the user wants one, run `testbox init` in the repo root, then edit it (see below).
3. You do not need `testbox start`. `verify` starts the workspace itself the first time.

## Run

```sh
testbox verify <profile> --json --quiet   # a profile from testbox.yml
testbox run "<command>" --json --quiet    # any command, same flow
```

- Always pass `--json`. It prints NDJSON events and ends with one `summary` line, in one ordered stream. Without it, stdout and stderr can arrive out of order through a pipe.
- Prefer `--quiet` for test suites. The log is not printed; it is written to `.testbox/logs/<job-id>.log` (the `logFile` field of the summary). Read the end of that file when the job fails: `tail -n 100 <logFile>`, or grep it for `FAIL`, `error`, or the test name. Without `--quiet`, every log line is also an event, and the file is still written.
- The summary line has `state`, `exitCode` (the command's own status), `exit` (the CLI's exit code, see the table), `logFile`, and for a non-zero `exit` a `hint` that says what to do. `state` `detached` (exit 0) means the job still runs; its `hint` says how to follow it. Read `exit` from the summary or `$?`; both are the same.
- The `source` event shows which checkout the job tested: `path`, `branch`, `commit`, `dirty`, and `links` (the same for each linked checkout). Make sure it is the checkout you changed.
- A Claude Code Bash call ends at 600 s; the default job timeout is 1800 s (`--timeout <seconds>` changes it). Run `verify` with the tool's background option (`run_in_background` in Claude Code), or pass `--detach` (the summary has the job id) and then `testbox status <job-id>` or `testbox logs <job-id> --follow`. If the harness kills the CLI anyway, the job continues; `.testbox/logs/<job-id>.log` and `testbox status` still work.
- A profile command is fixed. For one test or one target, use `testbox run "<command>" --profile <name>`; the job gets the profile's `requires` and `artifacts`. Write the command the profile needs (for example source the same setup script).
- Never run two `verify` calls for the same profile at once: a newer queued job cancels the older queued one (exit 13).
- Artifacts: `testbox artifacts <job-id>` downloads them into `./.testbox/<job-id>/`.
- `testbox cancel <job-id>` stops a job.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | job passed | done |
| 1 | job failed | a real build or test failure: read the log and fix the code |
| 2 | bad call: unknown profile, missing or invalid `testbox.yml`, bad flag, a link with no checkout or no `testbox.yml`, a bad or repeated `--link`, a `--link` the profile does not have, two links to one checkout or a link that is this checkout, `--direct` with links, an `admin` command without `--address` or with a bad public key, an `--api-url` that is not an http(s) URL | fix the command line or `testbox.yml`, not the code |
| 10 | sync error: Mutagen, the snapshot copy, or the local checkout lock (`flock` missing, or another run holds it) | infrastructure: run `testbox doctor`; for `another testbox run holds`, wait for that run |
| 11 | no usable worker: none has all labels in `requires`, none with them is up, or SSH to it fails | run `testbox doctor`; if the labels are wrong, fix `requires` |
| 12 | timeout, or the worker stopped during the job (`lease_expired`) | raise `--timeout` or find the hang; for `lease_expired`, run `testbox doctor` |
| 13 | cancelled | someone cancelled it, or a newer submit replaced it |
| 20 | auth | the token is wrong; the user must ask an admin for a new `testbox setup` line |
| 21 | the API does not answer: no route to it, nothing listens, or it timed out | run `testbox doctor`; its fix line says whether it is the VPN or a stopped control plane |

Only exit 1 means the code is broken. For 10, 11, 12, 20, 21, do not change the code to "fix" it. Run `testbox doctor --json` (each check is a line, with a `fix`), report the problem and the fix it prints, and stop if the fix needs the user (SSH key, GUI login, Local Network permission, token).

## testbox.yml

```yaml
project: example-app            # letters, digits, . _ -
ignore:                         # not synced; replaces the default list
  - .git
  - node_modules
profiles:
  unit:
    command: pnpm test          # bash -c, in the repo root on the worker
    requires: [linux]           # worker labels; all must match
    artifacts:                  # globs to upload
      - coverage/**
  ios:
    command: xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
    requires: [macos, xcode]
    links: [api]                # the sibling checkout ../api, uncommitted changes too
```

Labels a worker finds itself: `macos` / `linux`, `arm64` / `x64`, `node`, `pnpm`, `mise`, `xcodegen`, `docker`, `browser`, `xcode`, `xcode-<version>`, `ios-simulator`, `worker:<id>`. Use labels; never name a host. Require only what the job needs: each extra label (for example `linux`) removes workers, and the jobs then wait for the remaining ones. Jobs go to the worker that ran this checkout last while it is free; otherwise to the least busy worker with the labels.

Rules for good profiles:
- The worker environment is minimal: only `PATH`, `HOME`, and a few system variables. Local env vars and `.env` files are not there.
- A missing tool (for example `JAVA_HOME is not set`): pin it in the repo's `mise.toml` and add `requires: [mise]`. The worker runs `mise install` and `mise exec` for each job.
- The worker installs `node_modules` itself (cached by lockfile) only when `package.json` and `pnpm-lock.yaml` are in the repo root; then do not put `pnpm install` in the command. For a package in a subfolder (for example `console/`), keep `pnpm install --frozen-lockfile` in the command.
- Testbox does not reset simulators, and other users can share the Mac. For a clean simulator, make one in the command (`xcrun simctl create`), use its UDID as the destination, and delete it in a `trap ... EXIT`.
- Swift on a Mac worker: use `swift test --build-system native`; the default build system hangs there.
- The build reads a path outside the repo (for example `../api/client/swift-client`)? Add `links: [api]`. The job then runs in a folder with `../api` next to it. The CLI finds `../api_<suffix>` (when this checkout is `<project>_<suffix>`) or `../api`; else pass `--link api=<path>`. The linked checkout needs its own `testbox.yml`. A missing one exits 2.
- `testbox init` adds `.testbox/` to `.gitignore`. Keep it there: it holds the workspace state and the job logs.

## More

- `testbox doctor`: checks the API, token, Mutagen, stale syncs, workers, and profiles, and prints a fix for each problem.
- `testbox prune`: terminates the stale syncs (the checkout is deleted, or no workspace owns the sync). `--dry-run` only prints them.
- `testbox <command> --help`: every option.
- Full reference and troubleshooting: https://github.com/luiseel/testbox/tree/master/docs
