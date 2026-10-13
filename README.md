# Testbox

Self-hosted pre-CI. You edit locally, including uncommitted work. `testbox` syncs that tree to a warm Mac and runs the build or the tests there, streaming logs back to the terminal.

```
developer machine                         Mac (testbox user, GUI session)
┌────────────┐   Mutagen one-way    ┌──────────────────────────────────┐
│ testbox CLI│ ───────────────────► │ ~/testbox/workspaces/<user>/<proj>│
└─────┬──────┘                      └──────────────────────────────────┘
      │ REST + SSE                         ▲
      ▼                                    │ BullMQ
┌────────────┐    Redis    ┌──────────────┴───────────┐
│ NestJS API │ ──────────► │ worker LaunchAgent       │
└────────────┘             │ snapshot, install, spawn │
                           └──────────────────────────┘
```

The worker pulls jobs. It does not expose a port. SSH is only for the file sync.

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
| LaunchAgent plist template, install script, machine-setup doc | done |
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
| 11 | no worker |
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
  ios:
    command: xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
    resources: exclusive
```

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

If no API URL is configured, `run` and `verify` execute on the Mac over SSH in the staging tree. That path is for bringing a machine up before the control plane. It still returns the exit codes above. It does not snapshot.

## Control plane

```sh
docker compose up -d --build
```

Set `TESTBOX_TOKENS=alice:secret` (comma-separated `userId:token`). The API stores a SHA-256 of the token. Requests send `Authorization: Bearer secret`. `POST /v1/jobs` is idempotent on `Idempotency-Key` plus a hash of the body.

Job states: `queued → assigned → running → succeeded | failed | cancelled | timed_out`. A terminal job is never moved back to a runnable state, including when a worker's lease expires. Heartbeats renew the lease every ~10s. The default lease is 30s. A sweeper runs every 15s.

Latest-wins: a newer queued job for the same user, workspace, and profile marks the older queued job `cancelled`. Different profiles are independent. Nothing already running is cancelled by a later submit. Equal priority is FIFO.

## Worker

See [docs/machine-setup.md](docs/machine-setup.md) for the account, SSH, Twingate, directory layout, and LaunchAgent install.

On Linux, for tests or a non-Xcode smoke run:

```sh
REDIS_URL=redis://127.0.0.1:6379 \
TESTBOX_DATA_DIR=/tmp/testbox \
pnpm --filter @testbox/worker start
```

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
packages/worker   BullMQ consumer, process groups, cache, simulator reset
packages/cli      commands, Mutagen, interrupt handling
deploy/           LaunchAgent template and install script
docs/             machine setup
```
