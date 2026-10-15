# Testbox

Self-hosted pre-CI. You edit locally, including uncommitted work. `testbox` syncs that tree to a warm worker (macOS or Linux) and runs the build or the tests there, streaming logs back to the terminal.

```
developer machine                         workers (one disk each)
┌────────────┐   Mutagen one-way    ┌──────────────────────────────────┐
│ testbox CLI│ ───────────────────► │ the worker selected for this job │
└─────┬──────┘                      │ ~/testbox/workspaces/<user>/<proj>│
      │ REST + SSE                  └──────────────────────────────────┘
      ▼                                    ▲
┌────────────┐    Redis    ┌──────────────┴───────────┐
│ NestJS API │ ──────────► │ scheduler → healthy      │
└────────────┘             │ worker with the labels   │
                           └──────────────────────────┘
```

Workers pull jobs they can run. They do not expose a port. SSH is only for the file sync, and each job's Mutagen session targets the worker that will run it.

## What this milestone includes

| Area | Status |
| --- | --- |
| pnpm workspace: `cli`, `api`, `worker`, `shared` | done |
| CLI `login start run verify status logs cancel artifacts stop` | done |
| Direct Mutagen + SSH path with the exit codes below | done |
| `testbox.yml` profiles, ignore list, light vs exclusive | done |
| Dependency fingerprint (lockfiles, Node, arch, Xcode) and warm `node_modules` cache | done |
| NestJS API, per-user bearer tokens, per-user staging trees | done |
| BullMQ queue, leases, heartbeats, latest-wins, FIFO | done |
| Immutable snapshot under an exclusive workspace lock | done |
| SSE log stream, NDJSON `--json` | done |
| Cancellation kills the process group, then SIGKILL | done |
| Worker-loss lease expiry fails the job and does not re-run it | done |
| Artifact and log retention, 7 days, caches kept | done |
| `docker-compose.yml` for Redis + API | done |
| LaunchAgent plist template, install script, macOS machine-setup doc | done |
| systemd unit template, install script, Linux machine-setup doc | done |
| Linux workers skip simulator reset and Xcode fingerprinting | done |
| Capability labels, heartbeats, and worker health | done |
| `mise` label, `mise install` and `mise exec` per job when the snapshot has a mise config | done |
| Label routing, affinity, capacity, exclusive class, fail-fast exit 11 | done |
| Mutagen session per worker, pinned to the worker that runs the job | done |
| A real Mutagen session against Apple Silicon, verified in Xcode | next: needs the Mac |
| Simulator reset beyond `simctl shutdown all` / `killall Simulator` | next: needs the Mac |
| Twingate connector config | next: site-specific |

Linux CI covers the queue, the snapshot lock, cancellation, and lease expiry. macOS-only steps are behind small commands the worker already invokes (`xcodebuild -version`, `xcrun simctl`).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | job passed |
| 1 | job failed |
| 10 | sync error |
| 11 | no compatible worker |
| 12 | timeout |
| 13 | cancelled |
| 20 | auth |

## Repo config

Copy `testbox.yml.example` to `testbox.yml`.

```yaml
project: example-app
ignore: [node_modules, dist, .git]
profiles:
  unit:
    command: pnpm test
    resources: light
  e2e:
    command: pnpm test:e2e
    resources: light
  ios:
    command: xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
    resources: exclusive
    requires: [macos, xcode]
```

`requires` is a list of worker labels. A JVM, Go, or Python project can require `[mise]` and pin its tools in `mise.toml` (see [Worker](#worker)). `unit` and `e2e` omit it and can run on any healthy worker. `ios` waits for a worker that advertises `macos` and `xcode`. If no registered worker has those labels, the API returns `NO_WORKER` and the CLI exits 11.

`verify <profile>` flushes Mutagen, asks the API to snapshot that user's staging tree, enqueues the job, and streams SSE until the job finishes. Ctrl-C on a TTY asks whether to cancel or detach. Without a TTY it cancels. `--detach` submits and returns the job id.

## CLI

```sh
pnpm install
pnpm --filter @testbox/cli build
# or, from packages/cli after a build:
node packages/cli/dist/main.js login --api http://127.0.0.1:3000 --token dev-token
```

Config lands in `~/.config/testbox/config.json` (mode 0600).

| Command | What it does |
| --- | --- |
| `login --api URL --token TOKEN` | stores the API URL and token |
| `start [--host user@mac]` | creates or resumes the Mutagen session |
| `run "<cmd>"` | flush, snapshot, enqueue, stream |
| `verify <profile>` | same, using the profile command |
| `status <job-id>` | one job |
| `logs <job-id> --follow` | SSE |
| `cancel <job-id>` | cooperative cancel; worker kills the process group |
| `artifacts <job-id>` | downloads into `./.testbox/<id>/` |
| `stop` | pauses the Mutagen session |

Flags: `--json`, `--detach`, `--timeout`, `--priority`, `--profile`, `--workspace`. `--json` prints NDJSON events and a final summary line.

If no API URL is configured, `run` and `verify` execute over SSH in the staging tree. That path is for bringing a machine up before the control plane. It still returns the exit codes above. It does not snapshot.

## Control plane

```sh
docker compose up -d --build
```

Set `TESTBOX_BOOTSTRAP_TOKEN` to seed an `admin` user. Create users with `POST /v1/users {"name"}` and mint their tokens with `POST /v1/users/:id/tokens`, both as admin. The API stores a SHA-256 of each token. Requests send `Authorization: Bearer <token>`. Set `TESTBOX_API_PORT` to publish the API on a host port other than 3000. `POST /v1/jobs` is idempotent on `Idempotency-Key` plus a hash of the body.

Job states: `queued → assigned → running → succeeded | failed | cancelled | timed_out`. A terminal job is never moved back to a runnable state, including when a worker's lease expires. Heartbeats renew the lease every ~10s. The default lease is 30s. A sweeper runs every 15s.

Latest-wins: a newer queued job for the same user, workspace, and profile marks the older queued job `cancelled`. Different profiles are independent. Nothing already running is cancelled by a later submit. Equal priority is FIFO.

## Scheduling

Workers register on a heartbeat with auto-detected labels plus any extras from `TESTBOX_LABELS` or `~/testbox/worker.yml`. Detected labels are the OS (`linux` or `macos`), the arch, `node`, `pnpm` and `mise` when they are on `PATH`, `browser`, and on macOS `xcode`, `xcode-<version>`, and `ios-simulator`. A worker is healthy while its heartbeat is newer than `TESTBOX_HEARTBEAT_TTL_MS` (15s).

The scheduler assigns a queued job only when a healthy worker:

- has every required label
- has a free slot (`TESTBOX_CAPACITY`, default 1)
- is not already running an `exclusive` job
- is idle, if this job is `exclusive` (that job takes the machine alone)

When several workers qualify, the one that last ran this workspace wins, so warm `node_modules` stays put. If that worker is full or unhealthy, another compatible worker takes the job. Higher priority still runs before lower priority. Equal priority stays FIFO.

If no registered worker's labels can ever cover the job, submit fails immediately. A compatible worker that is only busy or briefly down does not fail the submit; the job stays queued until a slot is free. A lost worker's lease still fails the running job, and no other worker re-runs it.

## Sync

`verify` asks the API which healthy worker should run the profile, opens or reuses a Mutagen session to that worker's `TESTBOX_SSH_HOST`, flushes it, and snapshots there. The job is pinned to that worker because the snapshot bytes are on its disk. Other workers keep their own sessions and their own caches. One SSH host and a shared data directory still work when workers do not publish `sshHost`; those jobs are not pinned.

## Worker

See [docs/machine-setup.md](docs/machine-setup.md) for the macOS account, SSH, Twingate, directory layout, and LaunchAgent install. See [docs/machine-setup-linux.md](docs/machine-setup-linux.md) for the systemd unit. Linux workers do not call `xcodebuild` or `simctl`.

On Linux, for tests or a non-Xcode smoke run:

```sh
REDIS_URL=redis://127.0.0.1:6379 \
TESTBOX_DATA_DIR=/tmp/testbox \
pnpm --filter @testbox/worker start
```

Install [mise](https://mise.jdx.dev/) on the worker to give jobs their own toolchains; the worker detects it and adds the `mise` label. When the snapshot has `mise.toml`, `.mise.toml`, or `.tool-versions`, the worker runs `mise install` (with `MISE_YES=1` and `MISE_TRUSTED_CONFIG_PATHS=<data dir>`) and then runs the job command with `mise exec --`. A failed `mise install` fails the job before the command runs. `pnpm install` runs only when the snapshot has `package.json` and `pnpm-lock.yaml`, so a Gradle or Swift project skips it.

Each job runs in its own session (`detached: true`), so the command and every child share a process group. The worker forwards SIGINT, SIGTERM, and SIGHUP to that group. On cancel or timeout it sends SIGTERM, waits, then SIGKILL. A watchdog reaps descendants if the parent exits first. Shell commands go through `bash -lc` with a single quoted `-c` argument.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Redis must be reachable at `127.0.0.1:6379` for the API integration tests. They flush only the `testbox:test:integration:*` prefix.

## Layout

```
packages/shared   states, fingerprints, snapshot lock, job store, shell quoting
packages/api      NestJS auth, jobs, SSE, retention
packages/worker   scheduler claim loop, process groups, cache, simulator reset
packages/cli      commands, per-worker Mutagen sessions, interrupt handling
deploy/           LaunchAgent and systemd templates, install scripts
docs/             macOS and Linux machine setup
```
