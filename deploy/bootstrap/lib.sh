# Shared helpers for the bootstrap scripts. The CLI sends this file, then the
# script body, to `bash -s` over SSH. Inputs arrive as exported TB_* variables
# at the top of that stream, so secrets never show in `ps` on the host.
set -euo pipefail

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# One JSON line on stdout that the CLI reads. Everything else goes to stderr.
result() { printf 'TESTBOX_RESULT %s\n' "$1"; }

expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

os_name() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# Homebrew lives outside the default PATH of a non-interactive SSH shell.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="$dir:$PATH" ;;
  esac
done
export PATH

# Install system packages without a prompt. Linux needs passwordless sudo
# (or root); otherwise the error names the packages to install by hand.
pkg_install() {
  if [ "$(os_name)" = macos ]; then
    have brew || fail "Homebrew is missing. Install it from https://brew.sh, then run this command again."
    log "brew install $*"
    brew install --quiet "$@" >&2
    return
  fi
  local sudo=""
  if [ "$(id -u)" -ne 0 ]; then
    sudo -n true 2>/dev/null || fail "need passwordless sudo to install: $*. Install them by hand, then run this command again."
    sudo="sudo -n"
  fi
  log "install $*"
  if have pacman; then
    $sudo pacman -S --needed --noconfirm "$@" >&2
  elif have apt-get; then
    $sudo apt-get update -qq >&2
    $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >&2
  elif have dnf; then
    $sudo dnf install -y -q "$@" >&2
  else
    fail "no supported package manager (pacman, apt-get, dnf). Install by hand: $*"
  fi
}

ensure_git() { have git || pkg_install git; }

# Clone the repo, or fast-forward an existing checkout to TB_GIT_REF.
sync_repo() {
  local dir="$1"
  ensure_git
  if [ -d "$dir/.git" ] || git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    log "update $dir to $TB_GIT_REF"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      fail "$dir has local changes. Commit or discard them, then run this command again."
    fi
    if git -C "$dir" show-ref --verify --quiet "refs/heads/$TB_GIT_REF"; then
      git -C "$dir" checkout --quiet "$TB_GIT_REF"
      # Commits that no remote branch had before this fetch exist only here.
      local unpushed
      unpushed=$(git -C "$dir" rev-list HEAD --not --remotes | head -n 1)
      git -C "$dir" fetch --quiet --prune origin
      if ! git -C "$dir" merge --quiet --ff-only "origin/$TB_GIT_REF" >/dev/null 2>&1; then
        [ -z "$unpushed" ] || fail "$dir has commits on $TB_GIT_REF that are not on the remote. Push or remove them, then run this command again."
        log "$TB_GIT_REF was rewritten on the remote; reset to origin/$TB_GIT_REF"
        git -C "$dir" reset --quiet --hard "origin/$TB_GIT_REF"
      fi
    else
      git -C "$dir" fetch --quiet --prune origin
      git -C "$dir" checkout --quiet -b "$TB_GIT_REF" "origin/$TB_GIT_REF"
    fi
  elif [ -e "$dir" ]; then
    fail "$dir exists and is not a git checkout"
  else
    log "clone $TB_GIT_URL into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --branch "$TB_GIT_REF" "$TB_GIT_URL" "$dir" >&2
  fi
}

random_secret() {
  if have openssl; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

# Read KEY from an env file, or print nothing.
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# Set KEY only when the file does not have a value yet, so a second run
# keeps the secrets that workers already use.
env_default() {
  local file="$1" key="$2" value="$3"
  if [ -z "$(env_get "$file" "$key")" ]; then
    sed -i.bak "/^${key}=/d" "$file" && rm -f "$file.bak"
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
