# Setup

You set up three kinds of machine, in this order:

1. **The control plane**: one host that runs the API and Redis in Docker.
2. **Workers**: the macOS and Linux machines that run the jobs.
3. **Developer machines**: the machines that run `testbox verify`.

The `testbox admin` commands do steps 1 and 2 over SSH from one machine, the *admin machine* (usually your laptop). Each command is safe to run again: it updates or repairs what is there and keeps the secrets. Each command ends with a check, so when it passes, that part works.

## Before you start

- **Fixed LAN addresses.** Give the control plane and each worker a fixed IP (a DHCP reservation is enough). Use IPs in all commands, not `.local` names: Twingate and the workers cannot resolve mDNS names.
- **SSH from the admin machine.** Your SSH key must open each host without a password: `ssh <user>@<ip> true`. Use one account per host for testbox. On a Mac, that account must be logged in to the GUI (see [macOS workers](#macos-workers)).
- **GitHub access on each host.** The hosts clone this repo. Check with `ssh <user>@<ip> git ls-remote <repo-url>`.
- **The CLI on the admin machine.** In a checkout of this repo: `./scripts/install-cli.sh`. The CLI runs from that checkout, and it sends the setup scripts in `deploy/bootstrap/` from it.

The commands install missing packages without a prompt: Homebrew on macOS, and `pacman`, `apt-get`, or `dnf` on Linux. On Linux that needs passwordless `sudo`. Without it, the command stops and names the packages to install.

## 1. The control plane

```sh
testbox admin init-control-plane <user>@<ip>
```

It does these steps:

1. Checks Docker. On Linux it installs Docker when it is missing. On a Mac, install OrbStack or Docker Desktop yourself.
2. Clones the repo into `~/testbox/app`, or fast-forwards it.
3. Writes `~/testbox/app/.env` (mode 0600) with three random secrets: the worker token, the bootstrap (admin) token, and the Redis password. A second run keeps them.
4. Runs `docker compose up -d --build` and waits until the API answers.
5. From the admin machine, checks `http://<ip>:3000/v1/healthz`.
6. Saves the host in `~/.config/testbox/admin.json`, makes your user, and logs you in.

Options: `--address` (when `<ip>` is not in the SSH host), `--api-port`, `--redis-port` (first run only; later, edit `.env`), `--ref <branch>`, `--user <name>`, `--git-url <url>`, `--repo-dir <dir>`, `--data-dir <dir>`.

The host must accept TCP 3000 (API) from developers and workers, and TCP 6379 (Redis, with a password) from workers only. The secrets stay on the control-plane host; the CLI reads them over SSH when it needs them.

## 2. Workers

```sh
testbox admin add-worker <user>@<ip>
```

It does these steps:

1. Installs `git`, `curl`, `flock`, and [mise](https://mise.jdx.dev/) when they are missing.
2. Clones or fast-forwards the repo into `~/testbox/app`, installs Node and pnpm from the repo's `mise.toml`, and builds the worker.
3. Links `node`, `flock`, and `mise` into `~/testbox/bin`. The service and the snapshot step use those, so no shell profile is needed.
4. Installs the service with the control plane's Redis URL, API URL, and worker token: a LaunchAgent on macOS (`~/Library/LaunchAgents/com.testbox.worker.plist`), or a systemd user unit on Linux (`~/.config/systemd/user/testbox-worker.service`). Both files are mode 0600.
5. Waits for the worker's first heartbeat.
6. Runs a real job that only this worker can take (it requires the label `worker:<id>`), and prints `testbox ok on <host>`.

Options: `--id <id>` (default `<short hostname>-1`, lower case), `--labels gpu,big-disk` (extra labels), `--capacity <n>` (jobs at the same time, default 1), `--address`, `--ref`, `--git-url`, `--repo-dir`, `--data-dir`, `--wait <seconds>` (for the first heartbeat, default 600), `--no-smoke`. When you are not logged in to this control plane, it skips the test job.

The worker finds its own labels: the OS (`macos` or `linux`), the arch, `node`, `pnpm`, `mise`, `browser`, `worker:<id>`, and on a Mac `xcode`, `xcode-<version>`, and `ios-simulator` (see [Labels](reference.md#labels)).

### macOS workers

These steps need a person at the Mac (or Screen Sharing). The command tells you when one is missing.

- **A GUI login.** The worker is a LaunchAgent, so that Xcode and the Simulator work. It runs only while its account is logged in. Turn on automatic login for that account, or keep it logged in.
- **Xcode**, for iOS jobs: install it from the App Store, open it once, and accept the license (`sudo xcodebuild -license accept`). Without Xcode, the worker runs but does not get the `xcode` labels.
- **Local Network permission.** macOS blocks the worker from the LAN until you allow it. When `add-worker` says that it waits for this, click **Allow** for "node" on the Mac's screen. If you missed the dialog, open **System Settings → Privacy & Security → Local Network** and turn on **node**. `add-worker` continues by itself when the worker connects. macOS can ask again after the worker's Node version changes.

### Linux workers

The worker is a systemd user unit. `add-worker` turns on *linger* for the account, so the worker keeps running after you log out. If it cannot, it prints a warning: run `sudo loginctl enable-linger <user>` once.

## 3. Developer machines

The admin makes a token for each person:

```sh
testbox admin add-user ana
```

It prints one line. Send it to that person over a private channel. On their machine, they install the CLI (`./scripts/install-cli.sh` in a checkout of this repo) and run that line:

```sh
testbox setup --api-url http://<control-plane-ip>:3000 --token <token>
```

`setup` installs Mutagen with Homebrew when it is missing, logs in, makes an SSH key when there is none, and runs `testbox doctor`. The first time, `doctor` shows that the workers refuse the new key, and prints a line like this:

```
fix: send this to an admin: testbox admin authorize 'ssh-ed25519 AAAA… ana@laptop'
```

The admin runs that line. It adds the key to every worker. Then the developer runs `testbox doctor` again; all checks must pass. Run `add-user` again for a person to give them a new token.

In each repo: `testbox init` writes a `testbox.yml` for what it finds (Node, Gradle, SwiftPM, Xcode, Go, Cargo, Python). Check it, then `testbox start` and `testbox verify <profile>`.

## Access from outside the LAN

Use [Twingate](https://www.twingate.com/). Put a connector on a host in the LAN (the control-plane host is a good place). Then make these resources, by IP address:

| Resource | Ports | Who uses it |
| --- | --- | --- |
| control-plane IP | 3000 | the CLI (API and live logs) |
| control-plane IP | 22 | the admin machine (`testbox admin`) |
| each worker IP | 22 | the CLI (file sync and snapshot) |

Do not add Redis (6379): only workers use it, and they are on the LAN.

## Updates

```sh
testbox admin upgrade          # the control plane, then every worker
```

It fast-forwards each checkout to `master` (or `--ref <branch>`), rebuilds, restarts, and waits for each worker. `--no-control-plane` updates the workers only. A worker whose service config must change (a new Redis password, labels, or capacity) needs `testbox admin add-worker` again.

To update the CLI: `git pull`, then `./scripts/install-cli.sh`.

## What is where

| Machine | Path | What |
| --- | --- | --- |
| admin | `~/.config/testbox/admin.json` | the control-plane host (no secrets) |
| developer | `~/.config/testbox/config.json` | API URL and your token (mode 0600) |
| control plane | `~/testbox/app/.env` | the secrets (mode 0600) |
| control plane | `~/testbox/app/.compose-up.log` | the last `docker compose up` output |
| worker | `~/testbox/app` | the checkout (or a link to it) |
| worker | `~/testbox/bin` | `node`, `flock`, `mise` for the service and SSH |
| worker | `~/testbox/workspaces`, `snapshots`, `cache` | synced trees (one folder for each checkout: `workspaces/<user>/<project>/<workspace id>`), job copies, warm dependencies |
| worker | `~/testbox/logs/worker.stderr.log`, `worker.stdout.log` | the macOS worker log (Linux: `journalctl --user -u testbox-worker`) |
| worker | `~/testbox/worker.yml` | optional extra `labels:` |

## Remove a worker

On the worker: `launchctl bootout gui/$(id -u)/com.testbox.worker` (macOS) or `systemctl --user disable --now testbox-worker` (Linux). It stops sending heartbeats, and the scheduler stops sending jobs to it.
