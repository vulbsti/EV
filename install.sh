#!/usr/bin/env bash
# Installs EV on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/vulbsti/EV/main/install.sh | bash
#
# It puts EV in ~/.ev (EV_HOME), installs its one npm dependency, builds the
# container its agents run in (if docker is running), and links the `ev`
# command into ~/.local/bin (EV_BIN_DIR). It never uses sudo and installs
# nothing system-wide. Run it again to update. Options (after `bash -s --`):
#   --no-image   skip building the agent container
set -euo pipefail

main() {
  local repo=${EV_REPO:-https://github.com/vulbsti/EV}
  local home=${EV_HOME:-$HOME/.ev}
  local bin_dir=${EV_BIN_DIR:-$HOME/.local/bin}
  local need_node=22.19.0 build_image=yes
  for arg in "$@"; do
    case $arg in
      --no-image) build_image="" ;;
      *) fail "Unknown option: $arg" ;;
    esac
  done

  case $(uname -s) in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "EV supports macOS and Linux for now. On Windows, use WSL2." ;;
  esac

  say "Checking what EV needs"
  command -v git >/dev/null 2>&1 || fail "git is missing. $(hint git)"
  command -v node >/dev/null 2>&1 || fail "Node.js $need_node or newer is missing. $(hint node)"
  local have_node
  have_node=$(node -p 'process.versions.node')
  version_ge "$have_node" "$need_node" || fail "EV needs Node.js $need_node or newer; you have $have_node. $(hint node)"
  ok "Node.js $have_node"
  local docker_ok=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker_ok=yes; ok "docker is running"
  else
    local why="docker is not installed"
    command -v docker >/dev/null 2>&1 && why="docker is installed but not running (or your user cannot use it)"
    warn "$why. EV's agents run in a container, so EV can talk but not do work until docker runs. $(hint docker)"
  fi

  if [ -d "$home/.git" ]; then
    say "Updating EV in $home"
    git -C "$home" pull --ff-only --quiet || fail "Could not update $home (local changes?). Fix it there, or move it away and run this again."
  elif [ -e "$home" ]; then
    fail "$home exists but is not an EV checkout. Move it away, or set EV_HOME to another folder."
  else
    say "Downloading EV to $home"
    git clone --quiet --depth 1 "$repo" "$home"
  fi

  say "Installing EV's dependencies"
  (cd "$home" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

  if [ ! -f "$home/.env" ]; then
    cp "$home/.env.example" "$home/.env"
    chmod 600 "$home/.env"
    ok "Settings file created: $home/.env"
  fi

  if [ -n "$build_image" ] && [ -n "$docker_ok" ]; then
    say "Building the agent container (a few minutes the first time)"
    (cd "$home" && docker build --quiet -t "${EV_OPENCLAW_IMAGE:-ev-openclaw}" docker/openclaw >/dev/null)
    ok "Agent container built"
  fi

  mkdir -p "$bin_dir"
  ln -sf "$home/bin/ev" "$bin_dir/ev"
  ok "Linked the ev command into $bin_dir"

  echo
  echo "EV is installed. Next:"
  if grep -q '^OPENCODE_API=$' "$home/.env"; then echo "  Put your model key in $home/.env (OPENCODE_API=...)."; fi
  echo "  Run: ev open"
  if [ -z "$docker_ok" ]; then echo "  Then start docker and run: ev update   (builds the agent container)"; fi
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo; echo "$bin_dir is not on your PATH. Add this line to your shell profile, then open a new terminal:"
       echo "  export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

# True when version $1 >= $2 (both x.y.z).
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]; }

hint() {
  case "$os:$1" in
    macos:git) echo "Install it with: xcode-select --install" ;;
    macos:node) echo "Install it with: brew install node (https://brew.sh), or from https://nodejs.org" ;;
    macos:docker) echo "Install and start Docker Desktop, OrbStack or colima." ;;
    linux:git) echo "Install it with your package manager, e.g. sudo apt install git" ;;
    linux:node) echo "Install it from https://nodejs.org/en/download (nvm or fnm work too)." ;;
    linux:docker) echo "See https://docs.docker.com/engine/install/, and make sure your user can run docker." ;;
  esac
}

main "$@"
