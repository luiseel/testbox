# Print the control-plane secrets as one JSON line, for the admin CLI only.
# Inputs: TB_REPO_DIR

env_file="$(expand_home "$TB_REPO_DIR")/.env"
[ -f "$env_file" ] || fail "$env_file not found. Run testbox admin init-control-plane first."

field() { printf '"%s":"%s"' "$1" "$(json_escape "$(env_get "$env_file" "$2")")"; }
result "{$(field workerToken TESTBOX_WORKER_TOKEN),$(field bootstrapToken TESTBOX_BOOTSTRAP_TOKEN),$(field redisPassword TESTBOX_REDIS_PASSWORD),$(field apiPort TESTBOX_API_PORT),$(field redisPort TESTBOX_REDIS_PORT)}"
