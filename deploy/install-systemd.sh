#!/bin/sh
# Install the Testbox worker as a systemd service.
# Default is a user unit (no root). Set TESTBOX_SYSTEMD_SCOPE=system and run
# as root to install a system unit that runs as the dedicated testbox user.
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
LABELS="${TESTBOX_LABELS:-}"
SERVICE_USER="${TESTBOX_SERVICE_USER:-testbox}"
SCOPE="${TESTBOX_SYSTEMD_SCOPE:-user}"
TEMPLATE="$REPO/deploy/testbox-worker.service.template"
NODE_DIR="$(dirname "$NODE_BIN")"
PATH_VALUE="${DATA_DIR}/bin:${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; set NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$REPO/packages/worker/dist/main.js" ]; then
  echo "build the worker first: pnpm --filter @testbox/worker build" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/logs" "$DATA_DIR/workspaces" "$DATA_DIR/cache" "$DATA_DIR/snapshots"

if [ "$SCOPE" = "system" ]; then
  DEST="/etc/systemd/system/testbox-worker.service"
  USER_LINE="User=${SERVICE_USER}"
  WANTED_BY="multi-user.target"
  HOME_DIR="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  if [ -z "$HOME_DIR" ]; then
    echo "user ${SERVICE_USER} does not exist" >&2
    exit 1
  fi
  SYSTEMCTL="systemctl"
else
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/testbox-worker.service"
  USER_LINE=""
  WANTED_BY="default.target"
  HOME_DIR="$HOME"
  SYSTEMCTL="systemctl --user"
  mkdir -p "$(dirname "$DEST")"
fi

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
  -e "s|__LABELS__|$LABELS|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__PATH__|$PATH_VALUE|g" \
  -e "s|__USER_LINE__|$USER_LINE|g" \
  -e "s|__WANTED_BY__|$WANTED_BY|g" \
  "$TEMPLATE" > "$DEST"
# The unit holds the worker token and the Redis password.
chmod 600 "$DEST"

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable testbox-worker.service
$SYSTEMCTL restart testbox-worker.service
echo "installed $DEST"
