# Reference

## Commands

Run `testbox <command> --help` for every option.

### Developer

| Command | What it does |
| --- | --- |
| `setup --api-url URL --token TOKEN` | Installs Mutagen if missing, logs in, makes an SSH key if there is none, then runs `doctor`. |
| `doctor` | Checks the API, the token, Mutagen, each worker, and the profiles in `testbox.yml`. Prints a fix for each problem. |
| `init [--force]` | Writes a starting `testbox.yml` for the repo. |
| `login --api-url URL --token TOKEN [--ssh-host HOST]` | Stores the API URL and token in `~/.config/testbox/config.json` (mode 0600). |
| `start` | Creates the workspace and starts the Mutagen sync. |
| `verify <profile>` | Flush, snapshot, queue, and stream the profile's command. |
| `run "<command>" [--profile NAME]` | The same, for any command. |
| `status <job-id>`, `logs <job-id> [--follow]`, `cancel <job-id>` | One job. |
| `artifacts <job-id>` | Downloads the job's artifacts into `./.testbox/<job-id>/`. |
| `stop` | Stops the sync and deletes the workspace. |

Flags for `verify` and `run`: `--detach` (submit and return the job id), `--timeout <seconds>` (default 1800), `--priority <n>`, `--workspace <id>`, `--direct` (see [Without a control plane](#without-a-control-plane)), `--ssh-host <host>`, `--json` (NDJSON events and a final summary line). `start` takes the same flags. Ctrl-C on a terminal asks whether to cancel or detach; without a terminal it cancels.

### Admin

| Command | What it does |
| --- | --- |
| `admin init-control-plane <user@ip>` | Installs or updates the API and Redis, writes the secrets, logs you in. |
| `admin add-worker <user@ip>` | Installs, updates, or repairs a worker, waits for it, runs a test job on it. |
| `admin upgrade [--no-control-plane]` | Updates the control plane, then every worker. With `--no-control-plane`, only the workers. |
| `admin add-user <name>` | Makes the user if needed, prints a `testbox setup` line with a new token. |
| `admin authorize '<public key>'` | Adds an SSH public key to every worker. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | job passed |
| 1 | job failed, or any other error (for example a failed `doctor` check) |
| 10 | sync error (Mutagen) |
| 11 | no compatible worker: no worker has the labels, none with the labels sends heartbeats, SSH to the worker fails, or the API answers 503 |
| 12 | timeout, or the worker stopped during the job (its lease expired) |
| 13 | cancelled |
| 20 | auth (the API answers 401 or 403) |

## testbox.yml

```yaml
project: example-app            # letters, digits, . _ -; starts with a letter or digit; at most 81 characters
ignore:                         # not synced; this list replaces the default list
  - .git
  - node_modules
sshHost: user@10.0.0.5         # optional; only for --direct
profiles:
  unit:
    command: pnpm test          # runs with `bash -c` in the repo root on the worker (`cmd` also works)
    requires: [linux]           # worker labels; all must match
    artifacts:                  # globs to upload; get them with `testbox artifacts`
      - coverage/**
```

The CLI finds `testbox.yml` in the current directory or a parent. It ignores unknown keys. The default `ignore` list is `node_modules`, `.next`, `.git`, `.env`, `.env.*`, `dist`, `build`, `coverage`, `DerivedData`, `.turbo`, `.testbox`.

Testbox does not reset or erase simulators. Other jobs, CI runners, or people can use the same Mac. A job that needs a clean simulator makes its own (`xcrun simctl create`) and deletes it at the end.

## Labels

A worker finds these labels itself:

| Label | When |
| --- | --- |
| `macos` or `linux`, `arm64` or `x64` | always |
| `node` | always |
| `pnpm`, `mise` | when they are on the worker's `PATH` |
| `browser` | when `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `firefox`, or `microsoft-edge` is on the login shell's `PATH` (an app in `/Applications` only is not found) |
| `xcode`, `xcode-<version>` | when `xcodebuild -version` works |
| `ios-simulator` | when `xcrun simctl help` works |
| `worker:<id>` | always; targets one worker |

Add more with `testbox admin add-worker --labels a,b`, `TESTBOX_LABELS`, or `labels:` in `~/testbox/worker.yml`.

## Scheduling

A worker is healthy while its heartbeat is newer than 15 s (`TESTBOX_HEARTBEAT_TTL_MS`). The scheduler gives a queued job to a healthy worker that:

- has every required label
- has a free slot (`TESTBOX_CAPACITY`, default 1)

When several workers qualify, the one that last ran this workspace wins, so its warm caches are used. Higher priority runs first; equal priority is first in, first out.

Before it submits, `verify` asks the API for a worker. If no healthy worker has the labels, the submit fails at once (exit 11). After the submit, the job is pinned to that worker; when the worker is busy, the job waits.

Latest wins: a newer queued job for the same user, workspace, and profile cancels the older queued one. This applies only to jobs with a profile; `run "<command>"` jobs without `--profile` do not cancel each other. A running job is never cancelled by a newer submit.

Job states: `queued → assigned → running → succeeded | failed | cancelled | timed_out`. The worker renews a lease (30 s) while it runs a job. When a worker stops, its lease expires and the job goes to `timed_out` (exit 12). No other worker runs it again. A worker that cannot renew its lease stops the command.

## Sync and snapshots

`verify` asks the API which worker will run the profile, then opens or reuses a Mutagen session to that worker (one-way, your machine → worker) and flushes it. Over SSH it then copies the synced tree to `~/testbox/snapshots/<id>` under a lock, and registers the snapshot's digest. The job is pinned to that worker, because the snapshot is only on its disk. You can continue to edit; the job uses the frozen copy.

## On the worker, for each job

4. Runs the command with `bash -c` in its own process group, under `mise exec --` when step 2 ran. `$0` of that shell is `testbox-job:<job id>`, so the worker can find the process again after a crash and stop it. On cancel or timeout: SIGTERM to the group, then SIGKILL.

The job's environment has only `PATH`, `HOME`, `LANG`, `TERM`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, `PNPM_HOME`, `DEVELOPER_DIR`, `SSH_AUTH_SOCK`, `XPC_SERVICE_NAME`, `DISPLAY`, and `TESTBOX_JOB_ID`, plus `MISE_YES` and `MISE_TRUSTED_CONFIG_PATHS` when step 2 ran. The log masks the worker token, the bootstrap token, the Redis password, `Bearer …` values, and `token=`, `password=`, `secret=`, `api_key=`, `authorization=` values.

The API deletes job records, logs, and artifacts on the control plane after 7 days. Workers do not delete their snapshots (`~/testbox/snapshots`) or job logs (`~/testbox/logs`) yet. Workspaces and caches are kept.

## Settings

### Control plane (`~/testbox/app/.env`, read by `docker compose`)

| Variable | Default | |
| --- | --- | --- |
| `TESTBOX_WORKER_TOKEN` | random | workers use it to upload artifacts |
| `TESTBOX_BOOTSTRAP_TOKEN` | random | the admin token |
| `TESTBOX_REDIS_PASSWORD` | random | empty means no password (local development only) |
| `TESTBOX_API_PORT`, `TESTBOX_REDIS_PORT` | 3000, 6379 | host ports |
| `TESTBOX_DATA_DIR` | `~/testbox` (written by `init-control-plane`) | artifacts and logs of the API; mounted at `/data` in the container |

The API code also reads `TESTBOX_HEARTBEAT_TTL_MS` (15000), `TESTBOX_SWEEPER_MS` (5000), and `TESTBOX_RETENTION_MS` (7 days), but `docker-compose.yml` does not pass them to the container, so a value in `.env` has no effect. The worker uses a fixed lease of 30 s and a fixed heartbeat TTL of 15 s.

### Worker (in the LaunchAgent or systemd unit that `add-worker` writes)

| Variable | |
| --- | --- |
| `REDIS_URL` | `redis://:<password>@<control-plane-ip>:6379` |
| `TESTBOX_API_URL` | `http://<control-plane-ip>:3000` |
| `TESTBOX_WORKER_TOKEN` | the control plane's worker token |
| `TESTBOX_WORKER_ID` | `<short hostname>-1` |
| `TESTBOX_SSH_HOST` | `<user>@<worker-ip>`, what developers sync to |
| `TESTBOX_CAPACITY` | jobs at the same time |
| `TESTBOX_LABELS` | extra labels, comma-separated |
| `TESTBOX_DATA_DIR` | `~/testbox` |
| `TESTBOX_WORKER_CONFIG` | path to a `worker.yml` (default `~/testbox/worker.yml`; with this variable the file must exist) |

### Developer (`~/.config/testbox/config.json`)

`apiUrl`, `token`, and optionally `remoteRoot` (the worker data directory, default `~/testbox`) and `identityFile` (an SSH key other than your default key).

## Without a control plane

With `--direct`, `start`, `run`, and `verify` do not use the API: they sync to the host in `--ssh-host` (or `sshHost` in `testbox.yml` or the config) and run the command over SSH in the synced tree. This is for bringing up a single machine. It has the same exit codes, but no queue and no snapshot. Without `--direct`, the CLI needs a login (exit 20).
