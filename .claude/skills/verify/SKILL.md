---
name: verify
description: Run the built testbox CLI against a real API, a real worker daemon, and a throwaway Redis on this machine, with no SSH or Mutagen.
---

# Verify testbox locally

1. `pnpm build`.
2. Redis: `docker run -d --name testbox-verify-$$ -p 127.0.0.1::6379 redis:7`. Read the port with `docker port`. Remove the container at the end.
3. API: `exec node packages/api/dist/main.js` with `PORT`, `REDIS_URL`, a unique `TESTBOX_KEY_PREFIX`, a temporary `TESTBOX_DATA_DIR`, `TESTBOX_BOOTSTRAP_TOKEN`, and `TESTBOX_WORKER_TOKEN`.
4. Worker: `exec node packages/worker/dist/main.js` with the same `REDIS_URL`, prefix, and data dir, and with `TESTBOX_WORKER_ID`, `TESTBOX_LABELS`, `TESTBOX_CAPACITY`, `TESTBOX_API_URL`, and `TESTBOX_WORKER_TOKEN`. It runs jobs on this machine.
5. Users: `POST /v1/users` with the bootstrap token, then `POST /v1/users/<id>/tokens`.
6. CLI: set `HOME` to a temporary folder for each user, then run `node packages/cli/dist/main.js login --api-url <url> --token <token>`. This keeps `~/.config/testbox` safe.

## Make a job without SSH or Mutagen

`verify` and `run` need SSH and Mutagen to a worker. To make a worker busy without them:

1. `POST /v1/workspaces` with `{"project":"demo"}`. Make `<data dir>/<stagingRel>` and put a file in it.
2. `node packages/worker/dist/snapshot-cli.js --data-dir <dir> --staging-rel <rel> --snapshot-id snap_<24 hex>`.
3. `POST /v1/workspaces/<id>/snapshots` with the `id` and `digest`.
4. `POST /v1/jobs` with `workspaceId`, `snapshotId`, `command`, `profile`, `targetWorkerId`, and `timeoutMs`.

## Gotchas

- Use `exec` for each service. Without it, `kill $!` stops only the wrapper shell, and the service continues to run.
- Stop the API before you remove Redis. Without Redis, the API did not stop on SIGTERM; it needed `kill -9`.
- A worker counts as down 15 s after its last heartbeat.
- To simulate an API that does not answer, or an older API, use a small `node -e` HTTP server on a free port, and write that URL in the temporary config.
- Do not run `testbox doctor` with a temporary `HOME` unless you need it: it uses Mutagen.
