# Set up, update, or repair a worker on this host. Run by
# `testbox admin add-worker` and `testbox admin upgrade`. Safe to run again.
#
# Inputs:
#   TB_MODE          install (write the service config) or upgrade (code only)
#   TB_REPO_DIR TB_GIT_URL TB_GIT_REF TB_DATA_DIR
#   TB_REDIS_URL TB_API_URL TB_WORKER_TOKEN      (install)
#   TB_WORKER_ID TB_ADDRESS TB_CAPACITY TB_LABELS (install; id may be empty)

export MISE_YES=1

os=$(os_name)
repo=$(expand_home "$TB_REPO_DIR")
data_dir=$(expand_home "$TB_DATA_DIR")
bin_dir="$data_dir/bin"

ensure_tools() {
  have curl || pkg_install curl
  ensure_git
  if [ "$os" = macos ]; then
    have flock || pkg_install flock
    have mise || pkg_install mise
  else
    have flock || pkg_install util-linux
    if ! have mise; then
      log "install mise into ~/.local/bin"
      curl -fsSL https://mise.run | sh >&2
    fi
  fi
  have mise || fail "mise is not on PATH after install"
}

build() {
  cd "$repo"
  mise trust "$repo/mise.toml" >&2
  log "mise install (node and pnpm from mise.toml)"
  mise install >&2
  log "pnpm install"
  mise exec -- pnpm install --frozen-lockfile >&2
  log "build shared and worker"
  mise exec -- pnpm --filter @testbox/shared build >&2
  mise exec -- pnpm --filter @testbox/worker build >&2
}

# Stable paths for the service and for SSH commands from the CLI, which do
# not read shell profiles: $data_dir/bin/{node,flock,mise}.
link_bin() {
  mkdir -p "$bin_dir"
  node_path=$(cd "$repo" && mise exec -- node -p process.execPath)
  ln -sfn "$node_path" "$bin_dir/node"
  ln -sfn "$(command -v flock)" "$bin_dir/flock"
  ln -sfn "$(command -v mise)" "$bin_dir/mise"
  # The CLI runs ~/testbox/app/packages/worker/dist/snapshot-cli.js.
  if [ "$repo" != "$data_dir/app" ]; then
    if [ -e "$data_dir/app" ] && [ ! -L "$data_dir/app" ]; then
      fail "$data_dir/app exists and is not a link to $repo"
    fi
    ln -sfn "$repo" "$data_dir/app"
  fi
}

install_service() {
  local wid="$TB_WORKER_ID"
  [ -n "$wid" ] || wid="$(hostname -s | tr '[:upper:]' '[:lower:]')-1"
  worker_id="$wid"
  export TESTBOX_REPO="$repo" NODE_BIN="$bin_dir/node" TESTBOX_DATA_DIR="$data_dir"
  export REDIS_URL="$TB_REDIS_URL" TESTBOX_API_URL="$TB_API_URL" TESTBOX_WORKER_TOKEN="$TB_WORKER_TOKEN"
  export TESTBOX_WORKER_ID="$wid" TESTBOX_SSH_HOST="$(id -un)@$TB_ADDRESS" TESTBOX_CAPACITY="$TB_CAPACITY"
  export TESTBOX_LABELS="$TB_LABELS"
  if [ "$os" = macos ]; then
    sh "$repo/deploy/install-launchagent.sh" >&2
  else
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || warn "could not enable linger; the worker stops when $(id -un) logs out"
    sh "$repo/deploy/install-systemd.sh" >&2
  fi
}

restart_service() {
  if [ "$os" = macos ]; then
    launchctl kickstart -k "gui/$(id -u)/com.testbox.worker" >&2 ||
      fail "the worker LaunchAgent is not loaded. Run testbox admin add-worker for this host."
  else
    systemctl --user restart testbox-worker.service >&2 ||
      fail "the worker service is not installed. Run testbox admin add-worker for this host."
  fi
}

# macOS blocks a LaunchAgent from the LAN until someone allows Local Network
# for node. SSH sessions are not blocked, so only the worker log shows it.
local_network_blocked() {
  [ "$os" = macos ] || { printf false; return; }
  local log_file="$data_dir/logs/worker.stderr.log"
  sleep 8
  if [ -f "$log_file" ] && tail -n 20 "$log_file" | grep -q EHOSTUNREACH; then printf true; else printf false; fi
}

ensure_tools
sync_repo "$repo"
build
link_bin
worker_id="${TB_WORKER_ID:-}"
if [ "$TB_MODE" = install ]; then
  install_service
else
  restart_service
fi

xcode=false
if [ "$os" = macos ] && xcodebuild -version >/dev/null 2>&1; then xcode=true; fi
blocked=$(local_network_blocked)
result "{\"os\":\"$os\",\"workerId\":\"$(json_escape "$worker_id")\",\"xcode\":$xcode,\"localNetworkBlocked\":$blocked,\"node\":\"$(json_escape "$("$bin_dir/node" -v)")\"}"
