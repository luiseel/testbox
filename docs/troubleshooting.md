# Troubleshooting

Start with `testbox doctor`. It checks the API, your token, Mutagen, each worker (heartbeat, SSH, snapshot tools), and the profiles in `testbox.yml`, and it prints a fix for each problem.

The worker log is `~/testbox/logs/worker.stderr.log` on a Mac, and `journalctl --user -u testbox-worker` on Linux.

## Workers

| Symptom | Cause | Fix |
| --- | --- | --- |
| Mac worker log: `redis: connect EHOSTUNREACH <ip>:6379`. `ssh <mac> nc -z <ip> 6379` works. | macOS blocks the LaunchAgent from the LAN until someone allows it. SSH sessions are not blocked. | On the Mac's screen: **Allow** for "node", or **System Settings → Privacy & Security → Local Network** → turn on **node**. macOS can ask again after a Node update. |
| Worker log: `NOAUTH` or `WRONGPASS`. | The Redis password is new or changed (for example the first `init-control-plane` on an old setup). | `testbox admin add-worker <user>@<ip>` for that worker. |
| `add-worker` waits for the heartbeat, and it is not a Mac. | The worker cannot reach Redis or the API. | On the worker: `nc -z <control-plane-ip> 6379` and `3000`. Check the firewall on the control-plane host. |
| Worker gets no `xcode` label. | No Xcode, or its license is not accepted. | Install Xcode, open it once, `sudo xcodebuild -license accept`, then `add-worker` again. |
| `launchctl bootstrap failed; is <user> logged in to the GUI?` | A LaunchAgent needs a GUI session. | Log in to that account on the Mac (or turn on automatic login), then run the command again. |
| Linux worker stops when you log out. | No linger for the account. | `sudo loginctl enable-linger <user>` once. |

## Jobs

| Symptom | Cause | Fix |
| --- | --- | --- |
| `verify` exits 2. | The call is wrong: unknown profile, no or invalid `testbox.yml`, a bad flag. The message names the profiles or the YAML problem. | Fix the command line or `testbox.yml`. The code did not run. |
| `verify` exits 11: `no registered worker can satisfy required labels`. | No registered worker has all the labels in `requires`. | `testbox doctor` names the profile. Change `requires`, or add a worker with the label (`add-worker --labels …`). |
| `verify` exits 11: `no compatible worker is heartbeating`. | The workers with those labels are down. | `testbox doctor`. A down worker: `testbox admin add-worker` for it. |
| The job stays `queued`. | Its worker is busy, or it stopped after the submit. | `testbox status <job-id>`, then `testbox doctor`. |
| `verify` exits 11, `Permission denied (publickey)`. | The worker does not have your SSH key. | `testbox doctor` prints a `testbox admin authorize '<key>'` line; send it to an admin. |
| `verify` exits 11, `Operation timed out` or `Could not resolve hostname`. | You are not on the LAN, or the worker is off. | Turn on Twingate (see [setup](setup.md#access-from-outside-the-lan)). Use IPs, not `.local` names. |
| Snapshot fails: `node: command not found` or `spawn flock ENOENT`. | The worker was set up before `testbox admin add-worker` existed. | `testbox admin add-worker <user>@<ip>`. |
| `JAVA_HOME is not set` (or another missing tool). | The worker has no such tool on `PATH`. | Pin the tool in the repo's `mise.toml` and `requires: [mise]`. The worker runs `mise install` and `mise exec` for each job. |
| `swift build` or `swift test` prints nothing and never ends on a Mac worker. | Swift Build hangs in a LaunchAgent session. | Use `swift test --build-system native` (`testbox init` writes this). |
| A job tests files from another checkout, or old files. | A stale sync, or two syncs to the same worker folder (for example `testbox start` in two checkouts of one project). | `testbox doctor` names them. Then `testbox prune`, or `testbox stop` in the checkout you do not use. |
| The last log lines look missing when you pipe `verify … 2>&1`. | The job's stdout and stderr are two streams; through one pipe they can arrive out of order. | Nothing is lost. Use `--json` for one ordered stream. |
| The CLI was killed by a tool timeout (for example a Bash call that ends at 600 s). | The tool sent SIGTERM or SIGHUP. The CLI detaches; it does not cancel the job. | The job continues. The summary has `state` `detached` and the job id. Run `testbox logs <job-id> --follow` or `testbox status <job-id>`. Next time, run `verify` in the background or with `--detach`. |
| `verify` exits 12 with `lease_expired`. | The worker stopped or lost Redis during the job. | `testbox doctor`, then run the job again. |
| `verify` exits 20. | Your token is wrong or was replaced. | Ask an admin: `testbox admin add-user <your name>` prints a new `testbox setup` line. |

## Setup commands

| Symptom | Cause | Fix |
| --- | --- | --- |
| `has local changes` | Someone edited the checkout on the host. | On the host: commit, stash, or discard the changes in `~/testbox/app`. |
| `has commits on <branch> that are not on the remote` | The host checkout has commits that exist only there. The command does not delete them. | Push them, or reset that checkout on the host after you check them. |
| `docker compose up failed` | See `~/testbox/app/.compose-up.log` on the host. `port is already allocated`: another container uses 3000 or 6379. | `docker ps` on the host. Stop the other stack, or set `TESTBOX_API_PORT` / `TESTBOX_REDIS_PORT` in `~/testbox/app/.env` (`--api-port` / `--redis-port` work only on the first run). |
| `Docker is missing. Install OrbStack …` | A Mac host has no Docker. | Install OrbStack or Docker Desktop, start it, then run the command again. |
| `Docker is installed but not running, or this user cannot use it` | The Docker daemon is stopped. | Start Docker on the host, then run the command again. |
| `Docker is installed. Log out and in again` | The account was just added to the `docker` group. | Log out and in on the host, then run the command again. |
| `need passwordless sudo to install: …` | A Linux package is missing. | Install those packages, or allow passwordless sudo, then run the command again. |
| `the API runs on <host>, but this machine cannot reach …` | A firewall on the control-plane host, or the wrong `--address`. | Allow TCP 3000. Pass the LAN IP with `--address`. |
