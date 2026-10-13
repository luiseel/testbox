#!/bin/sh
# Install the Testbox worker as a launchd LaunchAgent in the logged-in GUI session.
# Run this as the dedicated `testbox` user (a GUI login), not as a system daemon.
set -eu

REPO="${TESTBOX_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DATA_DIR="${TESTBOX_DATA_DIR:-$HOME/testbox}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
API_URL="${TESTBOX_API_URL:-http://127.0.0.1:3000}"
WORKER_ID="${TESTBOX_WORKER_ID:-$(hostname -s)-1}"
WORKER_TOKEN="${TESTBOX_WORKER_TOKEN:-}"
SSH_HOST="${TESTBOX_SSH_HOST:-testbox@$(hostname -s)}"
CAPACITY="${TESTBOX_CAPACITY:-1}"
TEMPLATE="$REPO/deploy/com.testbox.worker.plist.template"
DEST="${HOME}/Library/LaunchAgents/com.testbox.worker.plist"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; set NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$REPO/packages/worker/dist/main.js" ]; then
  echo "build the worker first: pnpm --filter @testbox/worker build" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/logs" "$DATA_DIR/workspaces" "$DATA_DIR/cache" "$DATA_DIR/snapshots" "$HOME/Library/LaunchAgents"

sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__REDIS_URL__|$REDIS_URL|g" \
  -e "s|__DATA_DIR__|$DATA_DIR|g" \
  -e "s|__WORKER_ID__|$WORKER_ID|g" \
  -e "s|__API_URL__|$API_URL|g" \
  -e "s|__WORKER_TOKEN__|$WORKER_TOKEN|g" \
  -e "s|__SSH_HOST__|$SSH_HOST|g" \
  -e "s|__CAPACITY__|$CAPACITY|g" \
  "$TEMPLATE" > "$DEST"

launchctl bootout "gui/$(id -u)/com.testbox.worker" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/com.testbox.worker"
launchctl kickstart -k "gui/$(id -u)/com.testbox.worker"
echo "installed $DEST"
