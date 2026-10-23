#!/usr/bin/env bash
# Run every test suite against a Redis of its own.
#
# The shared, worker and api suites need Redis. This script finds one in this order:
#   1. TESTBOX_TEST_REDIS_URL is set: use it as it is.
#   2. redis-server is on PATH: start one on a free port, stop it at the end.
#   3. docker is on PATH: run redis:7 on a random host port, remove it at the end,
#      and remove the containers that killed runs on this machine left behind.
# The suites read the URL from TESTBOX_TEST_REDIS_URL. Port 6379 is never assumed,
# so a Redis of another project on this machine is never touched.
#
# The snapshot tests also need `flock` and `rsync` (macOS: brew install flock).
#
# TESTBOX_TEST_PACKAGES limits the run to some packages, for example "worker".
set -euo pipefail
cd "$(dirname "$0")/.."

run_tests() {
  local filters=() name
  for name in ${TESTBOX_TEST_PACKAGES:-shared worker api cli}; do
    filters+=(--filter "@testbox/$name")
  done
  pnpm -r "${filters[@]}" run test "$@"
}

machine_id() {
  # A hostname is not unique on a Docker daemon shared between machines. Prints
  # nothing when there is no reliable id; the caller then removes no container.
  cat /etc/machine-id 2>/dev/null ||
    ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ { print $4 }' ||
    true
}

process_start() {
  # $1: a pid. Prints when it started, or nothing if it is gone. A reused pid
  # has another start time, so the pair identifies one process.
  # C locale and UTC: the string must not depend on the environment of the run.
  LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'
}

wait_for_redis() {
  # $1: a command that answers PONG when Redis is ready
  for _ in $(seq 1 100); do
    if eval "$1" 2>/dev/null | grep -q PONG; then return 0; fi
    sleep 0.1
  done
  echo "redis did not become ready" >&2
  return 1
}

if ! command -v flock >/dev/null; then
  echo "flock is missing; the snapshot tests need it (macOS: brew install flock)" >&2
  exit 1
fi

if [ -n "${TESTBOX_TEST_REDIS_URL:-}" ]; then
  echo "tests: redis at $TESTBOX_TEST_REDIS_URL" >&2
  run_tests "$@"
  exit
fi

if command -v redis-server >/dev/null; then
  dir="$(mktemp -d)"
  trap 'redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
  # Port 0 is not accepted by redis-server, so ask the kernel for a free one.
  port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  redis-server --daemonize yes --bind 127.0.0.1 --port "$port" --save "" --appendonly no \
    --dir "$dir" --logfile "$dir/redis.log" --pidfile "$dir/redis.pid" >/dev/null
  wait_for_redis "redis-cli -p $port ping"
  export TESTBOX_TEST_REDIS_URL="redis://127.0.0.1:$port"
  echo "tests: redis-server on port $port" >&2
  run_tests "$@"
  exit
fi

if command -v docker >/dev/null; then
  # A run that was killed (SIGKILL, a tool timeout) never reaches its trap and
  # leaves its container behind. Remove the ones whose script is no longer running.
  # The labels name the machine and the process that started each container.
  machine="$(machine_id | head -n 1)"
  if [ -n "$machine" ]; then
    docker ps -a --filter "label=testbox.test.machine=$machine" \
      --format '{{.ID}}{{"\t"}}{{.Names}}{{"\t"}}{{.Label "testbox.test.pid"}}{{"\t"}}{{.Label "testbox.test.start"}}' |
      while IFS=$'\t' read -r id stale pid start; do
        if [ -z "$start" ] || [ "$(process_start "$pid")" != "$start" ]; then
          # By id, not by name: a concurrent run may reuse the name meanwhile.
          docker rm -f "$id" >/dev/null 2>&1 || true
          echo "tests: removed stale $stale" >&2
        fi
      done
  fi
  name="testbox-test-redis-$$"
  # Host port 0: Docker picks a free one.
  docker run -d --rm --name "$name" -p 127.0.0.1:0:6379 \
    --label "testbox.test.machine=$machine" --label "testbox.test.pid=$$" \
    --label "testbox.test.start=$(process_start $$)" redis:7 >/dev/null
  # Armed only after the run owns the container. If the name is taken on a
  # shared daemon, docker run fails and the other run's container stays.
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  port="$(docker port "$name" 6379/tcp | head -n 1 | sed 's/.*://')"
  wait_for_redis "docker exec $name redis-cli ping"
  export TESTBOX_TEST_REDIS_URL="redis://127.0.0.1:$port"
  echo "tests: redis in docker ($name) on port $port" >&2
  run_tests "$@"
  exit
fi

echo "no Redis for the tests: install redis-server or Docker, or set TESTBOX_TEST_REDIS_URL" >&2
exit 1
