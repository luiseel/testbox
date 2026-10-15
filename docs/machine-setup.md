# macOS machine setup

One Apple Silicon Mac, one dedicated `testbox` account. For a Linux worker see [machine-setup-linux.md](machine-setup-linux.md). A fleet can register both. The scheduler sends each job to a healthy worker whose labels cover the profile.

The macOS daemon is a LaunchAgent so Xcode and the iOS Simulator run inside a logged-in GUI session. Concurrency defaults to 1. Jobs labeled `exclusive` take the machine alone, and the worker shuts simulators down between those jobs. Linux workers skip that reset.

## Account

1. Create a local user named `testbox`. Give it a password and enable automatic login, or leave a GUI session logged in. A LaunchDaemon (system domain) cannot drive the Simulator.
2. Install Xcode and the iOS Simulator runtime. Open Xcode once as `testbox` and accept the license: `sudo xcodebuild -license accept`.
3. Install Node.js (22), pnpm, and [Mutagen](https://mutagen.io/) on both the developer machine and the worker. Install [mise](https://mise.jdx.dev/) on the worker so jobs can pin their own tools (see [Tools with mise](#tools-with-mise)). Playwright browsers can be installed into the warm cache on first run.

## SSH

Developers sync through SSH as `testbox`. Do not share one Unix account across people; each person gets their own API token and their own staging tree under `~/testbox/workspaces/<userId>/`.

```sh
# on the Mac, as testbox
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# append each developer's public key
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

### What SSH commands need

Before each job, the CLI runs `node ~/testbox/app/packages/worker/dist/snapshot-cli.js` on the worker over SSH. That command runs in a non-interactive shell, which does not read `~/.zprofile` or `~/.zshrc`. Do these three steps as `testbox`, or the snapshot fails:

1. Put `node` on the `PATH` for SSH commands. zsh reads `~/.zshenv` for every shell:

   ```sh
   echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshenv
   ```

   Without it: `node: command not found`.
2. Link the checkout to the path the CLI expects (`snapshotBin` in the CLI config):

   ```sh
   mkdir -p ~/testbox && ln -s ~/code/testbox ~/testbox/app
   ```

   Change `~/code/testbox` to the place of your checkout.
3. Install `flock`. macOS does not have it, and the snapshot uses it to lock the workspace:

   ```sh
   brew install flock
   ```

   Without it: `spawn flock ENOENT`.

Check from the developer machine: `ssh testbox@<mac> 'command -v node flock; ls ~/testbox/app/packages/worker/dist/snapshot-cli.js'` prints three paths.

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

On a fleet, Redis and the API run on one host. Set `REDIS_URL` and `TESTBOX_API_URL` to that host's LAN IP, not `127.0.0.1`. Set `TESTBOX_SSH_HOST` to `testbox@<lan-ip>`: a `.local` name does not resolve through Twingate.

`KeepAlive` restarts the process. The plist is `ProcessType=Interactive`. Logs: `~/testbox/logs/worker.*.log`. Keep backups of the plist out of `~/Library/LaunchAgents`, because launchd can load them at login.

### Local Network permission

macOS blocks a LaunchAgent from LAN addresses until the user allows it. SSH sessions are not blocked, so a test over SSH can pass while the worker fails. The worker log then shows `connect EHOSTUNREACH <redis-ip>:6379` and the worker does not register. On the Mac's screen, allow the prompt for `node`, or turn on `node` in **System Settings → Privacy & Security → Local Network**. You cannot do this over SSH.

## Tools with mise

Install [mise](https://mise.jdx.dev/) on the worker, as `testbox`, and put it on the `PATH` the worker starts with. The worker then adds the `mise` label by itself. A profile that needs a toolchain (Java, Go, Python, a pinned Node) can require `[mise]` in place of a label per tool.

When the snapshot has `mise.toml`, `.mise.toml`, or `.tool-versions`, the worker runs `mise install` in the snapshot before the dependency install, then runs the job command with `mise exec --`, so the tools are on `PATH`. The profile command does not need a `mise exec --` prefix. The worker sets `MISE_YES=1` and `MISE_TRUSTED_CONFIG_PATHS=<data dir>` because each job uses a new snapshot directory. If `mise install` fails, the job fails before the command runs. A worker without mise ignores the mise config and uses its own tools.

## Dependency fingerprint

Before install work, the worker hashes lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Podfile.lock`, `Package.resolved`), the Node version, architecture, and `xcodebuild -version`. A matching `cache/<fingerprint>/node_modules` is hardlinked into the snapshot. The install runs only when the snapshot has `package.json` and `pnpm-lock.yaml`. A miss runs `pnpm install --frozen-lockfile` in a throwaway copy and then promotes that `node_modules` into the cache. The snapshot's own `node_modules` is never the thing that gets cached, so a later job cannot poison the warm tree.
