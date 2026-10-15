# Set up or update the control plane (API + Redis in Docker) on this host.
# Run by `testbox admin init-control-plane`. Safe to run again: it keeps the
# secrets in .env and only adds the ones that are missing.
#
# Inputs: TB_REPO_DIR TB_GIT_URL TB_GIT_REF TB_API_PORT TB_REDIS_PORT TB_DATA_DIR

ensure_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || fail "Docker is installed but not running, or this user cannot use it. Start Docker (and add $(id -un) to the docker group on Linux), then run this command again."
    return
  fi
  if [ "$(os_name)" = macos ]; then
    fail "Docker is missing. Install OrbStack or Docker Desktop and start it, then run this command again."
  fi
  if have pacman; then
    pkg_install docker docker-compose
  elif have apt-get; then
    pkg_install docker.io docker-compose-v2
  else
    pkg_install docker docker-compose-plugin
  fi
  sudo -n systemctl enable --now docker >&2 || true
  sudo -n usermod -aG docker "$(id -un)" >&2 || true
  docker info >/dev/null 2>&1 || fail "Docker is installed. Log out and in again so $(id -un) is in the docker group, then run this command again."
}

wait_healthy() {
  local url="http://127.0.0.1:$1/v1/healthz"
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  docker compose logs --tail 40 api >&2 || true
  fail "the API did not answer at $url"
}

repo=$(expand_home "$TB_REPO_DIR")
data_dir=$(expand_home "$TB_DATA_DIR")

ensure_docker
have curl || pkg_install curl
sync_repo "$repo"
cd "$repo"

env_file="$repo/.env"
touch "$env_file"
chmod 600 "$env_file"
# Workers that joined before Redis had a password must be set up again.
redis_password_added=false
if [ -n "$(env_get "$env_file" TESTBOX_WORKER_TOKEN)" ] && [ -z "$(env_get "$env_file" TESTBOX_REDIS_PASSWORD)" ]; then
  redis_password_added=true
fi
env_default "$env_file" TESTBOX_WORKER_TOKEN "$(random_secret)"
env_default "$env_file" TESTBOX_BOOTSTRAP_TOKEN "$(random_secret)"
env_default "$env_file" TESTBOX_REDIS_PASSWORD "$(random_secret)"
env_default "$env_file" TESTBOX_DATA_DIR "$data_dir"
env_default "$env_file" TESTBOX_API_PORT "$TB_API_PORT"
env_default "$env_file" TESTBOX_REDIS_PORT "$TB_REDIS_PORT"
mkdir -p "$(env_get "$env_file" TESTBOX_DATA_DIR)"

log "docker compose up (this builds the API image)"
compose_log="$repo/.compose-up.log"
if ! docker compose up -d --build --remove-orphans >"$compose_log" 2>&1; then
  tail -n 40 "$compose_log" >&2
  fail "docker compose up failed. Full output: $compose_log on this host."
fi
port=$(env_get "$env_file" TESTBOX_API_PORT)
redis_port=$(env_get "$env_file" TESTBOX_REDIS_PORT)
wait_healthy "$port"
log "control plane is up on port $port"

result "{\"apiPort\":$port,\"redisPort\":$redis_port,\"repoDir\":\"$(json_escape "$repo")\",\"redisPasswordAdded\":$redis_password_added}"
