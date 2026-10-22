# Working in this repo

Testbox gives coding agents a self-hosted machine to run builds and tests on: the `testbox` CLI copies a checkout to a worker and runs a profile there. This file is for anyone (person or coding agent) who changes this repo.

## Verify a change

Run these from the repo root, in this order. All three must pass before a change is done.

```sh
pnpm typecheck   # tsrs -b over every package; also catches a stale import
pnpm lint        # eslint
pnpm test        # bash scripts/test.sh: every package's vitest suite
```

- `pnpm test` starts its own Redis (`redis-server` on PATH, or Docker) on a free port. It needs `flock` (macOS: `brew install flock`). Without Redis it exits 1 and says so; that is not a test failure.
- One package: `pnpm --filter @testbox/cli test`. The `cli` suite does not need Redis. `shared`, `worker` and `api` do; set `TESTBOX_TEST_REDIS_URL`, or use `TESTBOX_TEST_PACKAGES=worker pnpm test`.
- The tests do not touch the network, a real worker, or Mutagen. They fake `RemoteRunner` and `fetch` (see `packages/cli/test/agent.test.ts` for the shortest example). `packages/worker/test/daemon.test.ts` runs a real daemon against the test Redis.
- With a testbox login, `testbox verify check` runs all three on a worker (Linux or macOS). `testbox profiles` lists the faster profiles.
- `pnpm build` is only needed to run the built CLI (`node packages/cli/dist/main.js`) or before `./scripts/install-cli.sh`.
- `tsrs` is the compiler: a Rust port of TypeScript 7, pinned to one exact version. It has binaries for Apple Silicon and Linux (x64, arm64) only. The root `typescript` package is only there for eslint.

## Where things are

```
packages/shared   exit codes and hints, testbox.yml schema, job states, snapshot lock, shell quoting
packages/api      NestJS: auth, workspaces, jobs, SSE log stream, retention
packages/worker   claim loop, process groups, caches, mise
packages/cli      commands.ts (verify/run/start), developer.ts (doctor/init), admin.ts, main.ts (flags)
deploy/           LaunchAgent and systemd templates; deploy/bootstrap has the scripts testbox admin runs over SSH
skills/testbox    the skill coding agents install (npx skills add luiseel/testbox)
docs/             setup, reference, troubleshooting
```

## Rules

- The CLI is read by machines. Keep the `--json` contract in `docs/reference.md` ("Output with --json"): the last line is always a `summary`; `exit` is the process status; exit 2 is a bad call, exit 1 is a failed job. A new failure mode gets an exit code, a hint in `packages/shared/src/exit-codes.ts`, and a row in the skill and the reference.
- A change in behavior of `verify`, `run`, `doctor`, or `testbox.yml` also changes `skills/testbox/SKILL.md` and `docs/reference.md`. They are the agent's only view of the tool.
- Tests go next to the package in `test/`. Add a test for every exit code or JSON field you add. `packages/cli/test/agent.test.ts` is where the `--json` contract is tested.
- Docs and messages use short, direct sentences. Say what to do, not what went wrong in the abstract.
