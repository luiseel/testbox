#!/usr/bin/env bash
set -euo pipefail
if redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  exit 0
fi
redis-server \
  --daemonize yes \
  --bind 127.0.0.1 \
  --port 6379 \
  --protected-mode yes \
  --save "" \
  --appendonly no \
  --dir /tmp \
  --logfile /tmp/redis-testbox.log
for _ in $(seq 1 50); do
  if redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.1
done
echo "redis did not become ready" >&2
exit 1
