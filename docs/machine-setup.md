# Machine setup

One Apple Silicon Mac, one dedicated `testbox` account, one worker. The daemon is a LaunchAgent so Xcode and the iOS Simulator run inside a logged-in GUI session. Concurrency is 1. Jobs labeled `exclusive` (the default for anything that looks like Xcode or Playwright) take the machine alone, and the worker shuts simulators down between those jobs.

## Account

1. Create a local user named `testbox`. Give it a password and enable automatic login, or leave a GUI session logged in. A LaunchDaemon (system domain) cannot drive the Simulator.
2. Install Xcode and the iOS Simulator runtime. Open Xcode once as `testbox` and accept the license: `sudo xcodebuild -license accept`.
3. Install Node.js (22), pnpm, and [Mutagen](https://mutagen.io/) on both the developer machine and the worker. Playwright browsers can be installed into the warm cache on first run.

## SSH

Developers sync through SSH as `testbox`. Do not share one Unix account across people; each person gets their own API token and their own staging tree under `~/testbox/workspaces/<userId>/`.

```sh
# on the Mac, as testbox
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# append each developer's public key
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Remote login must be enabled. Mutagen sessions are one-way replicas (`developer -> testbox`) with `ignore-vcs` and the ignore list from `testbox.yml`. The CLI never interpolates shell commands into a remote string; arguments are quoted.

## Twingate

Put the Mac (SSH) and the API port on a Twingate resource. Developers reach both only through the connector. The API does not need to be on the public internet. Tokens are still required; Twingate is the network boundary, tokens are the user boundary.

## Layout

Everything durable lives in `~/testbox` (override with `TESTBOX_DATA_DIR`):

```
~/testbox/
  workspaces/<userId>/<project>/    # live Mutagen staging tree, per user
  cache/<fingerprint>/              # warm node_modules and tool caches
  snapshots/<jobId>/                # immutable copy taken under an exclusive lock
  jobs/<jobId>/logs.ndjson          # retained 7 days
  artifacts/<jobId>/                # retained 7 days
  logs/                             # LaunchAgent stdout/stderr
```

`cache/` and `workspaces/` are never deleted by retention. Snapshots, logs, and artifacts older than 7 days are removed hourly.

The API and the worker must see the same data directory so `testbox artifacts` can read what the worker wrote. On a single Mac, run Redis and the API with Docker and bind-mount the directory:

```sh
export TESTBOX_DATA_DIR=/Users/testbox/testbox
docker compose up -d --build
```

## Worker LaunchAgent

Build the worker, then install the agent as the `testbox` user (GUI session):

```sh
pnpm install
pnpm --filter @testbox/shared build
pnpm --filter @testbox/worker build
export REDIS_URL=redis://127.0.0.1:6379
export TESTBOX_API_URL=http://127.0.0.1:3000
export TESTBOX_WORKER_TOKEN=dev-worker-token
deploy/install-launchagent.sh
```

`KeepAlive` restarts the process. The plist is `ProcessType=Interactive`. Logs: `~/testbox/logs/worker.*.log`.

## Dependency fingerprint

Before install work, the worker hashes lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Podfile.lock`, `Package.resolved`), the Node version, architecture, and `xcodebuild -version`. A matching `cache/<fingerprint>/node_modules` is hardlinked into the snapshot. A miss runs `pnpm install --frozen-lockfile` in a throwaway copy and then promotes that `node_modules` into the cache. The snapshot's own `node_modules` is never the thing that gets cached, so a later job cannot poison the warm tree.
