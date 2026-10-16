#!/usr/bin/env bash
# Build the testbox CLI from this checkout and put `testbox` on PATH.
# Run it again after `git pull` to update. The CLI runs from this checkout,
# so keep it in place.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v mise >/dev/null 2>&1; then
  mise trust mise.toml >/dev/null
  mise install
  run() { mise exec -- "$@"; }
else
  command -v pnpm >/dev/null 2>&1 || {
    echo "install mise (https://mise.jdx.dev) or Node 22 with pnpm first" >&2
    exit 1
  }
  run() { "$@"; }
fi

run pnpm install --frozen-lockfile
run pnpm --filter @testbox/shared build
run pnpm --filter @testbox/cli build

if [ -z "${PNPM_HOME:-}" ]; then
  echo "PNPM_HOME is not set. Run 'pnpm setup', open a new terminal, then run this script again." >&2
  exit 1
fi
(cd packages/cli && run pnpm link --global)
echo "installed: $(command -v testbox || echo "$PNPM_HOME/testbox")"
