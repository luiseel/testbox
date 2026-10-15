# Linux machine setup

One Linux worker, one dedicated `testbox` account. The daemon is a systemd service. It does not reset simulators or fingerprint Xcode. Concurrency defaults to 1 (`TESTBOX_CAPACITY`). Jobs with `resources: exclusive` take the machine alone. Jobs with `resources: light` fill the remaining slots.

A fleet can mix this machine with the [macOS worker](machine-setup.md). The scheduler sends each job to a healthy worker whose labels cover the profile's `requires` list.

## Account

1. Create a local user named `testbox`. Give it a home directory and a login shell. It does not need a graphical session.
2. Install Node.js (22), pnpm, and [Mutagen](https://mutagen.io/) on both the developer machine and the worker. Install [mise](https://mise.jdx.dev/) on the worker so jobs can pin their own tools (see [Tools with mise](#tools-with-mise)). Install a browser on the worker only if a profile requires the `browser` label.

```sh
sudo useradd --create-home --shell /bin/bash testbox
sudo loginctl enable-linger testbox
```

`enable-linger` keeps a user systemd instance running after logout. Skip it when you install a system unit instead.

## SSH

Developers sync through SSH as `testbox`. Each person gets their own API token and their own staging tree under `~/testbox/workspaces/<userId>/`.

```sh
# on the worker, as testbox
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Remote login must be enabled. Mutagen sessions are one-way replicas (`developer -> testbox`) with the ignore list from `testbox.yml`. The CLI opens one session per worker and flushes the session for the worker that will run the job.

Set `TESTBOX_SSH_HOST` to the host developers use (`testbox@builder-1`, or an SSH config alias). The worker publishes that host with its heartbeat so the CLI can target it.

## Twingate

Put SSH and the API port on a Twingate resource. Developers reach both only through the connector. The API does not need to be on the public internet. Tokens are still required; Twingate is the network boundary, tokens are the user boundary.

## Layout

Everything durable lives in `~/testbox` (override with `TESTBOX_DATA_DIR`):

```
~/testbox/
  workspaces/<userId>/<project>/    # live Mutagen staging tree, per user
  cache/<fingerprint>/              # warm node_modules and tool caches
  snapshots/<jobId>/                # immutable copy taken under an exclusive lock
  jobs/<jobId>/logs.ndjson          # retained 7 days
  artifacts/<jobId>/                # retained 7 days
  logs/                             # optional file logs
  worker.yml                        # optional capacity, ssh host, extra labels
```

`cache/` and `workspaces/` are never deleted by retention. Snapshots, logs, and artifacts older than 7 days are removed hourly.

Each worker has its own disk. The API stores job metadata in Redis; the snapshot bytes stay on the worker that was synced. Do not point two workers at one data directory unless they are the same machine.

Optional `~/testbox/worker.yml`:

```yaml
capacity: 2
sshHost: testbox@builder-1
labels:
  - gpu
  - large-disk
```

`TESTBOX_LABELS` adds more labels. It does not replace the ones the worker detects (`linux` or `macos`, `arm64` or `x64`, `node`, `pnpm` and `mise` when they are on `PATH`, `browser` when a browser is installed). On macOS the worker also adds `xcode`, `xcode-<version>`, and `ios-simulator` when those tools exist. Linux never probes Xcode or the simulator.

## Worker service

Build the worker, then install the unit as `testbox`:

```sh
pnpm install
pnpm --filter @testbox/shared build
pnpm --filter @testbox/worker build
export REDIS_URL=redis://127.0.0.1:6379
export TESTBOX_API_URL=http://127.0.0.1:3000
export TESTBOX_WORKER_TOKEN=dev-worker-token
export TESTBOX_SSH_HOST=testbox@builder-1
deploy/install-systemd.sh
```

That installs a user unit. For a system unit run as root:

```sh
export TESTBOX_SYSTEMD_SCOPE=system
export TESTBOX_SERVICE_USER=testbox
export TESTBOX_DATA_DIR=/home/testbox/testbox
deploy/install-systemd.sh
```

`Restart=always` brings the process back. Logs: `journalctl --user -u testbox-worker` (or without `--user` for the system unit).

## Tools with mise

Install [mise](https://mise.jdx.dev/) on the worker, as `testbox`, and put it on the `PATH` the worker starts with. The worker then adds the `mise` label by itself. A profile that needs a toolchain (Java, Go, Python, a pinned Node) can require `[mise]` in place of a label per tool.

When the snapshot has `mise.toml`, `.mise.toml`, or `.tool-versions`, the worker runs `mise install` in the snapshot before the dependency install, then runs the job command with `mise exec --`, so the tools are on `PATH`. The profile command does not need a `mise exec --` prefix. The worker sets `MISE_YES=1` and `MISE_TRUSTED_CONFIG_PATHS=<data dir>` because each job uses a new snapshot directory. If `mise install` fails, the job fails before the command runs. A worker without mise ignores the mise config and uses its own tools.

## Dependency fingerprint

Before install work, the worker hashes lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Podfile.lock`, `Package.resolved`), the Node version, and the architecture. `xcodebuild` is not run. A matching `cache/<fingerprint>/node_modules` is hardlinked into the snapshot. The install runs only when the snapshot has `package.json` and `pnpm-lock.yaml`. A miss runs `pnpm install --frozen-lockfile` in a throwaway copy and then promotes that `node_modules` into the cache.
