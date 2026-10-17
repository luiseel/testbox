---
name: testbox
description: Run builds and tests on remote Testbox workers instead of the local machine. Use when a repo has a testbox.yml, when the user asks to verify, build, or test "on testbox" or "on a worker", when a test needs macOS, Xcode, an iOS simulator, or a browser the local machine lacks, or when the user wants to write or edit testbox.yml.
---

# Testbox

Testbox copies the local tree (uncommitted changes too) to a worker, runs a command there, and streams the log back. `testbox.yml` in the repo root (or a parent) defines named profiles.

## Before you run anything

1. Find `testbox.yml`. If there is none and the user wants one, run `testbox init`, then edit it (see below).
2. Read the profiles in it. Pick the profile whose `command` matches the task. Do not guess a profile name.
3. If a command fails with `no workspace; run testbox start`, run `testbox start` once, then retry.

## Run

```sh
testbox verify <profile> --json        # a profile from testbox.yml
testbox run "<command>" --json         # any command, same flow
```

- Always pass `--json`. It prints NDJSON events and a final summary line, in one ordered stream. Without it, stdout and stderr can arrive out of order through a pipe.
- The default timeout is 1800 s. Set the Bash tool timeout to match, or use `--timeout <seconds>`. For long jobs, use `--detach` (prints the job id), then `testbox logs <job-id> --follow` or `testbox status <job-id>`.
- Never run two `verify` calls for the same profile at once: a newer queued job cancels the older queued one (exit 13).
- Artifacts: `testbox artifacts <job-id>` downloads them into `./.testbox/<job-id>/`.
- `testbox cancel <job-id>` stops a job.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | job passed | done |
| 1 | job failed | a real build or test failure: read the log and fix the code |
| 10 | sync error (Mutagen) | infrastructure: run `testbox doctor` |
| 11 | no usable worker: none has all labels in `requires`, none with them is up, or SSH to it fails | run `testbox doctor`; if the labels are wrong, fix `requires` |
| 12 | timeout, or the worker stopped during the job (`lease_expired`) | raise `--timeout` or find the hang; for `lease_expired`, run `testbox doctor` |
| 13 | cancelled | someone cancelled it, or a newer submit replaced it |
| 20 | auth | the token is wrong; the user must ask an admin for a new `testbox setup` line |

Only exit 1 means the code is broken. For 10, 11, 12, 20, do not change the code to "fix" it. Run `testbox doctor`, report the problem and the fix it prints, and stop if the fix needs the user (SSH key, GUI login, Local Network permission, token).

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
```

Labels a worker finds itself: `macos` / `linux`, `arm64` / `x64`, `node`, `pnpm`, `mise`, `browser`, `xcode`, `xcode-<version>`, `ios-simulator`, `worker:<id>`. Use labels; never name a host.

Rules for good profiles:
- The worker environment is minimal: only `PATH`, `HOME`, and a few system variables. Local env vars and `.env` files are not there.
- A missing tool (for example `JAVA_HOME is not set`): pin it in the repo's `mise.toml` and add `requires: [mise]`. The worker runs `mise install` and `mise exec` for each job.
- With `package.json` and `pnpm-lock.yaml`, the worker installs `node_modules` itself (cached by lockfile). Do not put `pnpm install` in the command.
- Testbox does not reset simulators, and other users can share the Mac. For a clean simulator, make one in the command (`xcrun simctl create`), use its UDID as the destination, and delete it in a `trap ... EXIT`.
- Swift on a Mac worker: use `swift test --build-system native`; the default build system hangs there.

## More

- `testbox doctor`: checks the API, token, Mutagen, workers, and profiles, and prints a fix for each problem.
- `testbox <command> --help`: every option.
- Full reference and troubleshooting: https://github.com/luiseel/testbox/tree/master/docs
