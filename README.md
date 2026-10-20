# Testbox

Self-hosted pre-CI. You edit on your machine, also uncommitted work. `testbox verify <profile>` copies that tree to a worker (macOS or Linux), runs the build or the tests there, and streams the log back to your terminal.

```
your machine                           control plane (one host, Docker)
┌──────────────┐   REST + live logs    ┌──────────────┐     ┌───────┐
│ testbox CLI  │ ────────────────────► │ API  :3000   │ ──► │ Redis │ :6379
│ Mutagen      │                       └──────────────┘     └───▲───┘
└──────┬───────┘                                                │ jobs, heartbeats, logs
       │ SSH :22 (file sync + snapshot)                         │ (workers connect out)
       ▼                                                        │
┌───────────────────────────────────────────────────────────────┴──────┐
│ workers: macOS (LaunchAgent) or Linux (systemd), one disk each        │
│ ~/testbox/workspaces  your synced tree    ~/testbox/snapshots  jobs   │
└───────────────────────────────────────────────────────────────────────┘
```

Each checkout of a repo (also a git worktree) syncs into its own folder on the worker: `~/testbox/workspaces/<user>/<project>/<workspace id>`. Old flat folders (`workspaces/<user>/<project>`) stay on the worker until you remove them.

The control plane decides; it does not run code. Workers connect out to Redis and the API and pull the jobs that match their labels. Only SSH comes in to a worker, for the file sync.

## Set up

Do all of it from one machine that can SSH to each host. Every command is safe to run again: it repairs or updates.

```sh
# 0. The CLI, from a checkout of this repo
./scripts/install-cli.sh

# 1. The control plane (API + Redis in Docker). This also logs you in.
testbox admin init-control-plane <user>@<control-plane-ip>

# 2. Each worker. It waits for the worker, then runs a test job on it.
testbox admin add-worker <user>@<worker-ip>

# 3. Each developer: make a token, and send them the line it prints
testbox admin add-user <name>
#    The developer runs that line on their machine (after step 0):
testbox setup --api-url http://<control-plane-ip>:3000 --token <token>
```

[docs/setup.md](docs/setup.md) has the details: what each command does, the few steps it cannot do for you (Xcode, a GUI login, the macOS Local Network permission), access from outside the LAN with Twingate, and updates.

## Use

```sh
testbox init             # write testbox.yml for this repo, then edit it
testbox start            # start syncing this checkout (safe to run again)
testbox verify unit      # run the `unit` profile on a worker
testbox doctor           # when something is wrong: each problem, with its fix
```

```yaml
# testbox.yml
project: example-app
profiles:
  unit:
    command: pnpm test
  backend:
    command: cd backend && ./gradlew --no-daemon test
    requires: [mise]            # Java from the repo's mise.toml
  ios:
    command: xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
    requires: [macos, xcode]
```

For coding agents (Claude Code and others), install the skill: `npx skills add luiseel/testbox`.

`requires` lists worker labels. Labels pick the machine; you never name a host. `worker:<id>` targets one worker.

## Docs

- [docs/setup.md](docs/setup.md): set up the control plane, workers, and developer machines
- [docs/troubleshooting.md](docs/troubleshooting.md): symptoms, causes, and fixes
- [docs/reference.md](docs/reference.md): commands, `testbox.yml`, labels, scheduling, exit codes, settings

## Develop

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test        # needs redis-server; starts it on 127.0.0.1:6379 when none runs
```

```
packages/shared   states, fingerprints, snapshot lock, job store, shell quoting
packages/api      NestJS auth, jobs, SSE, retention
packages/worker   claim loop, process groups, caches, mise
packages/cli      commands, per-worker Mutagen sessions, testbox admin
deploy/           LaunchAgent and systemd templates, install scripts
deploy/bootstrap  the setup scripts that testbox admin runs over SSH
skills/testbox    the agent skill (npx skills add luiseel/testbox)
```
