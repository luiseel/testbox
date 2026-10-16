# Reference

## Commands

Run `testbox <command> --help` for every option.

### Developer

| Command | What it does |
| --- | --- |
| `setup --api-url URL --token TOKEN` | Installs Mutagen if missing, logs in, makes an SSH key if there is none, then runs `doctor`. |
| `doctor` | Checks the API, the token, Mutagen, each worker, and the profiles in `testbox.yml`. Prints a fix for each problem. |
| `init [--force]` | Writes a starting `testbox.yml` for the repo. |
| `login --api-url URL --token TOKEN` | Stores the API URL and token in `~/.config/testbox/config.json` (mode 0600). |
| `start` | Creates the workspace and starts the Mutagen sync. |
| `verify <profile>` | Flush, snapshot, queue, and stream the profile's command. |
| `run "<command>"` | The same, for any command. |
| `status <job-id>`, `logs <job-id> [--follow]`, `cancel <job-id>` | One job. |
| `artifacts <job-id>` | Downloads the job's artifacts into `./.testbox/<job-id>/`. |
| `stop` | Stops the sync and deletes the workspace. |

Flags for `verify` and `run`: `--detach` (submit and return the job id), `--timeout <seconds>` (default 1800), `--priority <n>`, `--workspace <id>`, `--json` (NDJSON events and a final summary line). Ctrl-C on a terminal asks whether to cancel or detach; without a terminal it cancels.

### Admin

| Command | What it does |
| --- | --- |
| `admin init-control-plane <user@ip>` | Installs or updates the API and Redis, writes the secrets, logs you in. |
| `admin add-worker <user@ip>` | Installs, updates, or repairs a worker, waits for it, runs a test job on it. |
| `admin upgrade` | Updates the control plane, then every worker. |
| `admin add-user <name>` | Makes the user if needed, prints a `testbox setup` line with a new token. |
| `admin authorize '<public key>'` | Adds an SSH public key to every worker. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | job passed |
| 1 | job failed |
| 10 | sync error (SSH, Mutagen, snapshot) |
| 11 | no compatible worker |
| 12 | timeout |
| 13 | cancelled |
| 20 | auth |

## testbox.yml

```yaml
project: example-app            # letters, digits, . _ -
ignore:                         # not synced; this list replaces the default list
  - .git
  - node_modules
profiles:
  unit:
    command: pnpm test          # runs with `bash -c` in the repo root on the worker
    resources: light            # light (default) or exclusive
    requires: [linux]           # worker labels; all must match
    artifacts:                  # globs to upload; get them with `testbox artifacts`
      - coverage/**
```

The CLI finds `testbox.yml` in the current directory or a parent. The default `ignore` list is `node_modules`, `.next`, `.git`, `.env`, `.env.*`, `dist`, `build`, `coverage`, `DerivedData`, `.turbo`, `.testbox`.

An `exclusive` job takes the worker alone. On a Mac, the worker shuts down and erases all simulators before an exclusive job (`xcrun simctl shutdown all`, `erase all`).

## Labels

A worker finds these labels itself:

| Label | When |
| --- | --- |
| `macos` or `linux`, `arm64` or `x64` | always |
| `node` | always |
| `pnpm`, `mise` | when they are on the worker's `PATH` |
| `browser` | when Chrome, Chromium, Firefox, or Edge is installed |
| `xcode`, `xcode-<version>`, `ios-simulator` | on a Mac with Xcode and `simctl` |
| `worker:<id>` | always; targets one worker |

Add more with `testbox admin add-worker --labels a,b`, `TESTBOX_LABELS`, or `labels:` in `~/testbox/worker.yml`.

## Scheduling

A worker is healthy while its heartbeat is newer than 15 s (`TESTBOX_HEARTBEAT_TTL_MS`). The scheduler gives a queued job to a healthy worker that:

- has every required label
- has a free slot (`TESTBOX_CAPACITY`, default 1)
- is not running an `exclusive` job
- is idle, when this job is `exclusive`

When several workers qualify, the one that last ran this workspace wins, so its warm caches are used. Higher priority runs first; equal priority is first in, first out.

If no registered worker can ever match the labels, the submit fails at once (exit 11). A matching worker that is busy or down for a short time does not fail the submit: the job waits.

Latest wins: a newer queued job for the same user, workspace, and profile cancels the older queued one. A running job is never cancelled by a newer submit.

Job states: `queued → assigned → running → succeeded | failed | cancelled | timed_out`. The worker renews a lease (30 s) while it runs a job. When a worker stops, its lease expires and the job fails. No other worker runs it again.

## Sync and snapshots

`verify` asks the API which worker will run the profile, then opens or reuses a Mutagen session to that worker (one-way, your machine → worker) and flushes it. Over SSH it then copies the synced tree to `~/testbox/snapshots/<id>` under a lock, and registers the snapshot's digest. The job is pinned to that worker, because the snapshot is only on its disk. You can continue to edit; the job uses the frozen copy.

## On the worker, for each job

1. Checks the snapshot digest.
2. With `mise.toml`, `.mise.toml`, or `.tool-versions` in the snapshot (and `mise` on the worker): runs `mise install` with `MISE_YES=1` and `MISE_TRUSTED_CONFIG_PATHS=<data dir>`. A failure fails the job before the command runs.
3. With `package.json` and `pnpm-lock.yaml`: links warm `node_modules` from the cache, or runs `pnpm install --frozen-lockfile` and stores the result. The cache key hashes the lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Podfile.lock`, `Package.resolved`), the Node version, the arch, and `xcodebuild -version`.
4. Runs the command in its own process group, under `mise exec --` when step 2 ran. On cancel or timeout: SIGTERM to the group, then SIGKILL.
5. Uploads the artifacts to the API.

The job's environment has only `PATH`, `HOME`, `LANG`, `TERM`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, `PNPM_HOME`, `DEVELOPER_DIR`, `SSH_AUTH_SOCK`, `XPC_SERVICE_NAME`, `DISPLAY`, and `TESTBOX_JOB_ID`. Secrets of the worker are masked in the log.

Snapshots, logs, and artifacts are deleted after 7 days. Workspaces and caches are kept.

## Settings

### Control plane (`~/testbox/app/.env`, read by `docker compose`)

| Variable | Default | |
| --- | --- | --- |
| `TESTBOX_WORKER_TOKEN` | random | workers use it to upload artifacts |
| `TESTBOX_BOOTSTRAP_TOKEN` | random | the admin token |
| `TESTBOX_REDIS_PASSWORD` | random | empty means no password (local development only) |
| `TESTBOX_API_PORT`, `TESTBOX_REDIS_PORT` | 3000, 6379 | host ports |
| `TESTBOX_DATA_DIR` | `~/testbox` | artifacts and logs of the API |

The API also reads `TESTBOX_LEASE_MS` (30000), `TESTBOX_HEARTBEAT_TTL_MS` (15000), `TESTBOX_SWEEPER_MS` (5000), and `TESTBOX_RETENTION_MS` (7 days).

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

### Developer (`~/.config/testbox/config.json`)

`apiUrl`, `token`, and optionally `remoteRoot` (the worker data directory, default `~/testbox`) and `identityFile` (an SSH key other than your default key).

## Without a control plane

With no API URL in the config, `run` and `verify` run over SSH in the synced tree of `--ssh-host`. This is for bringing up a single machine. It has the same exit codes, but no queue and no snapshot.
