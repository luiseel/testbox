# Reference

## Commands

Run `testbox <command> --help` for every option.

### Developer

| Command | What it does |
| --- | --- |
| `setup --api-url URL --token TOKEN` | Installs Mutagen (and on a Mac `flock`) if missing, logs in, makes an SSH key if there is none, then runs `doctor`. |
| `doctor` | Checks the API, the token, Mutagen, stale syncs, `flock`, each worker, and the profiles in `testbox.yml`, with one check per link of a profile (`link api of ios-unit: <path>`). Prints a fix for each problem. A stale sync has a deleted checkout, or no `.testbox/workspace.json` names it. Two checkouts that sync to the same worker folder also fail. |
| `init [--force]` | Writes a starting `testbox.yml` for the repo. |
| `login --api-url URL --token TOKEN [--ssh-host HOST]` | Stores the API URL and token in `~/.config/testbox/config.json` (mode 0600). |
| `profiles` | Lists the profiles of `testbox.yml` (name, labels, links as `+name`, command) and where the file is. With `--json`, one `profiles` event and a summary. |
| `start` | Creates the workspace and starts the Mutagen sync. You can run it again: it reuses the workspace and its live sessions. `verify` and `run` do this themselves when the checkout has no workspace yet, so `start` is optional. |
| `verify <profile>` | Flush, snapshot, queue, and stream the profile's command. The log is also written to `.testbox/logs/<job-id>.log`. |
| `run "<command>" [--profile NAME]` | The same, for any command. With `--profile`, the job also gets that profile's `requires`, `artifacts`, and `links`, so it runs on the same kind of worker (for example one test of an iOS profile). An unknown profile exits 2. The command does not change: write the setup the profile needs into it. The job counts as a job of that profile, so it replaces a queued `verify NAME` of the same workspace (see [Scheduling](#scheduling)). |
| `status <job-id>`, `logs <job-id> [--follow]`, `cancel <job-id>` | One job. |
| `artifacts <job-id>` | Downloads the job's artifacts into `./.testbox/<job-id>/`. |
| `stop` | Stops the sync and deletes the workspace. |
| `prune [--dry-run]` | Terminates the stale syncs on this machine. Live syncs stay. It does not use the API. With `--dry-run`, it only prints them. |

Flags for `verify` and `run`: `--detach` (submit and return the job id), `--timeout <seconds>` (default 1800), `--priority <n>`, `--workspace <id>`, `--direct` (see [Without a control plane](#without-a-control-plane)), `--ssh-host <host>`, `--quiet` (do not print the log; the file is still written), `--link <name>=<path>` (where the checkout of a link is; repeatable; a relative path is relative to the current directory; with `verify` or `run --profile` the profile must have that link; with `run` without `--profile`, the `--link` flags are the links), `--json` (see [Output with --json](#output-with---json)). `start` takes the same flags, except `--link`. Ctrl-C on a terminal asks whether to cancel or detach; without a terminal it cancels. SIGTERM and SIGHUP detach: the job continues on the worker, and the CLI prints the `detached` summary and exits 0. This is for a tool that kills the CLI at a time limit. A second SIGTERM ends the CLI at once. During the submit (sync, snapshot, queue), the signal is kept: the submit finishes, then the CLI prints the `detached` summary instead of following. This applies to jobs on the control plane; with `--direct` there is no job to detach from, and the signal ends the CLI and its command.

### Admin

| Command | What it does |
| --- | --- |
| `admin init-control-plane <user@ip>` | Installs or updates the API and Redis, writes the secrets, logs you in. |
| `admin add-worker <user@ip>` | Installs, updates, or repairs a worker, waits for it, runs a test job on it. |
| `admin upgrade [--no-control-plane]` | Updates the control plane, then every worker. With `--no-control-plane`, only the workers. |
| `admin add-user <name>` | Makes the user if needed, prints a `testbox setup` line with a new token. |
| `admin authorize '<public key>'` | Adds an SSH public key to every worker. |

Admin exit codes: 2 when the address is missing (pass `--address <LAN IP>`) or the public key is not one SSH public key line; 11 when the API does not answer after `init-control-plane` or `upgrade`, or a new worker sends no heartbeat; 1 when a worker fails in `upgrade` or `authorize`; a failed test job of `add-worker` gives the exit code of that job. With `--json`, each admin command ends with a `summary`, as every command does.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | job passed |
| 1 | job failed, or another error at run time (for example a failed `doctor` check) |
| 2 | bad call: unknown profile, missing or invalid `testbox.yml`, unknown flag or missing argument, bad `--timeout`, a link with no checkout or no `testbox.yml`, a `--link` the profile does not have, a bad or repeated `--link`, two links to one checkout or a link that is this checkout, `--direct` with links, an `admin` command without an address or with a bad public key |
| 10 | sync error: Mutagen, the snapshot copy, or the local checkout lock (`flock` is missing, or another run holds `.testbox/snapshot.lock` for over 15 minutes) |
| 11 | no compatible worker: no worker has the labels, none with the labels sends heartbeats, SSH to the worker fails, or the API answers 503 |
| 12 | timeout, or the worker stopped during the job (its lease expired) |
| 13 | cancelled |
| 20 | auth (the API answers 401 or 403) |

## Output with --json

Every command accepts `--json`. It writes NDJSON to stdout, one event per line, and the last line is always a `summary`, also when the command fails before a job exists. Stdout has nothing else. Stderr can still carry notes from `setup`, `init`, and a bad command line.

| Event | Fields | When |
| --- | --- | --- |
| `info`, `error` | `line` | A note, or an error that is not the end (for example a Mutagen resume that failed). |
| `source` | `path`, `branch`, `commit`, `dirty`, `links[]` (`name`, `path`, `branch`, `commit`, `dirty`) | Which checkout `verify` or `run` snapshotted, and each linked checkout. `branch`, `commit`, and `dirty` are missing when git fails. `links` is missing when the job has no links. |
| `status` | `state`, `jobId` | Each state change: `queued`, `assigned`, `running`. |
| `log` | `stream` (`stdout` or `stderr`), `line` | One line of the job log. Not printed with `--quiet`. |
| `check` | `ok`, `label`, `fix` | One `doctor` check. |
| `profiles` | `file`, `project`, `profiles[]` (`name`, `command`, `requires`, `artifacts`, `links`) | The `profiles` command. |
| `prune` | `name`, `root`, `reason`, `dryRun`, `ok`, `error` | One sync the `prune` command terminated (or would). |
| `user` | `name`, `apiUrl`, `token` | `admin add-user`. |
| `summary` | `exit`, `hint`, `exitCode`, `state` (a job state, `error`, or `detached`), `jobId`, `error`, `logFile`, and per command: `ok`, `source` (`status`), `failed` (`doctor`, `prune`), `count` and `dryRun` (`prune`), `file` and `profiles` (`init`) | The last line. |

In the summary, `exit` is the status of the CLI, the same as `$?`, and `exitCode` is the status of the command on the worker (`null` when it did not run). `hint` is present when `exit` is not 0, and on a `detached` summary; it says what to do, in one line. `logFile` is the local copy of the job log next to `testbox.yml`: `.testbox/logs/<job-id>.log`, or `.testbox/logs/run_<id>.log` with `--direct` (no job exists there). `logs --follow` writes it too when it runs inside a repo with `testbox.yml`. A `state` of `error` means the command stopped before a job existed; `error` has the message. A `state` of `detached` (exit 0, `exitCode` `null`) means the CLI stopped following a job that still runs: after `--detach`, SIGTERM, SIGHUP, or "detach" at the Ctrl-C prompt. Its `hint` is `the job continues on the worker: testbox logs <job-id> --follow, or testbox status <job-id>`. After `--detach` there is no `logFile`; `logs --follow` writes it. A log file that cannot be written does not fail the job: an `info` event says why, and the summary has no `logFile`.

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
  ios-unit:
    command: cd ios && xcodebuild test -scheme App
    requires: [macos, xcode]
    links: [api]                # other checkouts; each lands next to this tree on the worker
```

The CLI finds `testbox.yml` in the current directory or a parent. It ignores unknown keys.

`links` names other checkouts that the job sees as sibling folders, uncommitted changes included. Use it when the build reads a path outside the repo, for example a local Swift package at `../api/client/swift-client`. A link name has the same rules as `project`, and it cannot be the project name. A profile has at most 20 links. For link `api`, the CLI looks for the checkout in this order:

1. `--link api=<path>`.
2. When this checkout's folder is `<project>_<suffix>` (for example `interface_TGN-821`), the sibling `../api_TGN-821`.
3. The sibling `../api`.

When none exists, the job exits 2: `link api: no checkout at ../api_TGN-821 or ../api; pass --link api=<path>`. The linked checkout needs its own `testbox.yml`. Its `ignore` list applies to its sync and its snapshot copy. Its `project` names only its own workspace. Links need the control plane: `--direct` with links exits 2. The default `ignore` list is `node_modules`, `.next`, `.git`, `.env`, `.env.*`, `dist`, `build`, `coverage`, `DerivedData`, `.turbo`, `.testbox`.

Testbox does not reset or erase simulators. Other jobs, CI runners, or people can use the same Mac. A job that needs a clean simulator makes its own (`xcrun simctl create`) and deletes it at the end.

## Labels

A worker finds these labels itself:

| Label | When |
| --- | --- |
| `macos` or `linux`, `arm64` or `x64` | always |
| `node` | always |
| `pnpm`, `mise`, `xcodegen`, `docker` | when the command is on the login shell's `PATH` |
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

Latest wins: a newer queued job for the same user, workspace, and profile cancels the older queued one. This applies only to jobs with a profile; `run "<command>"` jobs without `--profile` do not cancel each other. A `run "<command>" --profile NAME` job and a `verify NAME` job have the same profile, so the newer one cancels the older one while it is queued. A running job is never cancelled by a newer submit.

Job states: `queued → assigned → running → succeeded | failed | cancelled | timed_out`. The worker renews a lease (30 s) while it runs a job. When a worker stops, its lease expires and the job goes to `timed_out` (exit 12). No other worker runs it again. A worker that cannot renew its lease stops the command.

## Sync and snapshots

`verify` asks the API which worker will run the profile, then opens or reuses a Mutagen session to that worker (one-way, your machine → worker) and flushes it. Over SSH it then copies the synced tree to `~/testbox/snapshots/<id>` under a lock, and registers the snapshot's digest. The job is pinned to that worker, because the snapshot is only on its disk. You can continue to edit; the job uses the frozen copy.

Each checkout of a repo gets its own workspace and its own folder on the worker: `~/testbox/workspaces/<user>/<project>/<workspace id>`. So a main checkout and a git worktree of one repo do not sync into the same folder. With `--direct`, the folder is `~/testbox/workspaces/local/<project>/<id>`, and the id is a short hash of the checkout directory.

`start` writes the workspace to `.testbox/workspace.json`. `verify` and `run` call the same code when that file is missing (or belongs to another checkout), so the first `verify` in a checkout also starts it. You can run `start` again safely. When the API still has the workspace, `start` reuses it and keeps the Mutagen sessions that are alive. It makes a session only when one is missing. When the API does not have the workspace, `start` stops the old sessions and makes a new workspace. With `--direct`, `start` stops the old session and makes it again.

With links, each linked checkout gets its own workspace and Mutagen session (and its own `.testbox/workspace.json`), on the worker that runs the job. `verify` flushes and pauses every session, takes one snapshot, and resumes every session, also when the snapshot fails. From the flush to the resume, the CLI holds an OS lock (`flock`) on `.testbox/snapshot.lock` in each checkout, so two runs on one machine that share a link wait for each other. The lock ends with the CLI, also when it is killed. `setup` installs `flock` on a Mac; Linux has it. The snapshot then has one folder per tree: `snapshots/<id>/<project>` holds this checkout and is the job's working directory, and `snapshots/<id>/<link name>` holds each link. So `../api` in the job is the linked checkout. The digest covers all of `snapshots/<id>`. Without links, the layout does not change: `snapshots/<id>` is the tree and the working directory.

Workspaces from before this layout use `~/testbox/workspaces/<user>/<project>`. When `start` finds such a workspace, it stops its sessions, deletes it, and makes a new one in the new layout. `start` also warns when another checkout on your machine still syncs into the same worker folder. The old folders stay on the worker until you remove them.

## On the worker, for each job

5. Runs the command with `bash -c` in its own process group, under `mise exec --` when step 3 ran. `$0` of that shell is `testbox-job:<job id>`, so the worker can find the process again after a crash and stop it. On cancel or timeout: SIGTERM to the group, then SIGKILL.

The job's environment has only `PATH`, `HOME`, `LANG`, `TERM`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, `PNPM_HOME`, `DEVELOPER_DIR`, `SSH_AUTH_SOCK`, `XPC_SERVICE_NAME`, `DISPLAY`, and `TESTBOX_JOB_ID`, plus `MISE_YES` and `MISE_TRUSTED_CONFIG_PATHS` when step 3 ran. The log masks the worker token, the bootstrap token, the Redis password, `Bearer …` values, and `token=`, `password=`, `secret=`, `api_key=`, `authorization=` values.

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
