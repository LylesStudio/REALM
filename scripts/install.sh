#!/usr/bin/env bash
# REALM one-command installer (curl | bash entry point).
#
# Flow: detect Node 22.13+ (offer a no-sudo user-local install) → fetch the
# REALM source (git clone, or tarball when git is absent) → npm ci → hand off
# to scripts/setup-web.sh (toolchain → PostgreSQL → seed → start → browser).
#
# Conservative by design:
# - nothing is installed without an explicit confirmation (or --yes);
# - piped execution without --yes reattaches /dev/tty so prompts stay usable;
# - all state lives under ${REALM_HOME:-~/.realm}; no sudo, no system changes;
# - re-running updates an existing clone in place.
#
# Useful environment overrides:
#   REALM_HOME          install root            (default ~/.realm)
#   REALM_SOURCE_URL    git URL or tarball URL  (default: read from ./.git,
#                       else the GitHub mirror placeholder)
#   REALM_INSTALL_REF   branch/tag to fetch     (default main)
#   REALM_INSTALL_SKIP_NPM=1   stop before npm ci (smoke testing)
#   REALM_INSTALL_SKIP_SETUP=1 stop before setup-web.sh (smoke testing)
#   --pg-artifact <url|path>   install the embedded PostgreSQL 17+pgvector
#                              bundle (linux-x64) via scripts/embedded-pg.mjs
set -euo pipefail

MIN_NODE="22.13.0"
REALM_HOME="${REALM_HOME:-$HOME/.realm}"
APP_DIR="$REALM_HOME/app"
REF="${REALM_INSTALL_REF:-main}"
AUTO_YES=0
PG_ARTIFACT="${REALM_PG_ARTIFACT:-}"
args=()
for arg in "$@"; do
  [[ "$arg" == "--yes" ]] && AUTO_YES=1
  args+=("$arg")
done
# extract --pg-artifact <value>（同时从透传给 setup-web 的参数中剔除）
next_is_pg=0
SETUP_ARGS=()
for arg in "${args[@]}"; do
  if [[ "$next_is_pg" == 1 ]]; then PG_ARTIFACT="$arg"; next_is_pg=0; continue; fi
  if [[ "$arg" == "--pg-artifact" ]]; then next_is_pg=1; continue; fi
  SETUP_ARGS+=("$arg")
done

log() { printf '\033[1;36m[realm]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[realm] error:\033[0m %s\n' "$*" >&2; exit 1; }

# --- piped curl|bash: reattach the terminal so confirmations stay possible ---
if [[ ! -t 0 && "$AUTO_YES" != 1 ]]; then
  if ! exec 0</dev/tty 2>/dev/null; then
    die "stdin is a pipe and no terminal is available; rerun with --yes for unattended installs"
  fi
fi

confirm() {
  local prompt="$1"
  if [[ "$AUTO_YES" == 1 ]]; then
    log "$prompt (--yes)"
    return 0
  fi
  local answer
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# --- 1. Node 22.13+ ------------------------------------------------------------
node_ok=0
if command -v node >/dev/null 2>&1; then
  if node -e 'const p=process.versions.node.split(".").map(Number);process.exit(p[0]>22||(p[0]===22&&p[1]>=13)?0:1)'; then
    node_ok=1
  fi
fi

if [[ "$node_ok" != 1 ]]; then
  NODE_DIR="$REALM_HOME/node"
  if [[ -x "$NODE_DIR/bin/node" ]] && "$NODE_DIR/bin/node" -e 'const p=process.versions.node.split(".").map(Number);process.exit(p[0]>22||(p[0]===22&&p[1]>=13)?0:1)'; then
    log "using bundled Node at $NODE_DIR"
  else
    platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "$arch" in
      x86_64) node_arch="x64" ;;
      aarch64|arm64) node_arch="arm64" ;;
      *) die "unsupported architecture: $arch (need x86_64 or arm64)" ;;
    esac
    case "$platform" in
      linux) node_platform="linux" ;;
      darwin) node_platform="darwin" ;;
      *) die "unsupported platform: $platform (this installer covers Linux and macOS; Windows uses scripts/setup-web.ps1)" ;;
    esac
    node_ver="v${MIN_NODE}"
    tarball="node-${node_ver}-${node_platform}-${node_arch}.tar.xz"
    url="https://nodejs.org/dist/${node_ver}/${tarball}"
    log "Node.js ${MIN_NODE}+ not found."
    confirm "Download $url into $NODE_DIR (no sudo)?" \
      || die "Node.js ${MIN_NODE}+ is required; install it and rerun."
    mkdir -p "$REALM_HOME"
    tmp_tarball="$(mktemp)"
    trap 'rm -f "$tmp_tarball"' EXIT
    curl -fsSL "$url" -o "$tmp_tarball" || die "failed to download $url"
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xJf "$tmp_tarball" -C "$NODE_DIR" --strip-components=1
    rm -f "$tmp_tarball"
    trap - EXIT
    log "Node $("$NODE_DIR/bin/node" --version) installed under $NODE_DIR"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi

command -v npm >/dev/null 2>&1 || die "npm is missing next to node; install Node.js ${MIN_NODE}+ properly"

# --- 2. Source -----------------------------------------------------------------
SOURCE_URL="${REALM_SOURCE_URL:-}"
if [[ -z "$SOURCE_URL" && -d "$(dirname "${BASH_SOURCE[0]}")/../.git" ]]; then
  repo_dir="$(dirname "${BASH_SOURCE[0]}")/.."
  # prefer origin, else whatever the first configured remote is
  SOURCE_URL="$(git -C "$repo_dir" remote get-url origin 2>/dev/null \
    || git -C "$repo_dir" remote 2>/dev/null | head -n 1 | xargs -r -I{} git -C "$repo_dir" remote get-url {} 2>/dev/null \
    || true)"
fi
if [[ -z "$SOURCE_URL" ]]; then
  SOURCE_URL="https://github.com/Silver-Aurora/REALM.git"
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "updating existing clone at $APP_DIR ($REF)"
  git -C "$APP_DIR" fetch --depth 1 origin "$REF"
  git -C "$APP_DIR" checkout -q FETCH_HEAD
elif [[ -d "$APP_DIR" && -f "$APP_DIR/package.json" ]]; then
  log "using existing source at $APP_DIR (not a git clone; skipping update)"
elif [[ "$SOURCE_URL" == http* && "$SOURCE_URL" != *.git ]]; then
  # tarball URL (e.g. a release asset or codeload archive)
  confirm "Download and extract $SOURCE_URL into $APP_DIR?" || die "aborted"
  mkdir -p "$APP_DIR"
  curl -fsSL "$SOURCE_URL" | tar -xz -C "$APP_DIR" --strip-components=1
else
  confirm "Clone $SOURCE_URL ($REF) into $APP_DIR?" || die "aborted"
  mkdir -p "$REALM_HOME"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REF" "$SOURCE_URL" "$APP_DIR" \
      || git clone --depth 1 "$SOURCE_URL" "$APP_DIR" \
      || die "git clone failed: $SOURCE_URL"
  else
    # no git: fall back to the codeload tarball for a GitHub-style URL
    case "$SOURCE_URL" in
      https://github.com/*/*.git)
        slug="${SOURCE_URL#https://github.com/}"
        slug="${slug%.git}"
        tarball_url="https://codeload.github.com/${slug}/tar.gz/refs/heads/${REF}"
        ;;
      *)
        die "git is required for this source URL: $SOURCE_URL"
        ;;
    esac
    log "git not found; downloading $tarball_url"
    mkdir -p "$APP_DIR"
    curl -fsSL "$tarball_url" | tar -xz -C "$APP_DIR" --strip-components=1 \
      || die "failed to download source tarball"
  fi
fi

[[ -f "$APP_DIR/package.json" ]] || die "no package.json under $APP_DIR; source fetch looks broken"

# --- 3. Dependencies ------------------------------------------------------------
if [[ "${REALM_INSTALL_SKIP_NPM:-0}" == 1 ]]; then
  log "REALM_INSTALL_SKIP_NPM=1 → stopping before npm ci"
  exit 0
fi
log "installing npm dependencies (ci)"
npm --prefix "$APP_DIR" ci

# --- 4. Embedded PostgreSQL (optional, explicit opt-in) -------------------------
if [[ -n "$PG_ARTIFACT" ]]; then
  pg_tmp="$PG_ARTIFACT"
  if [[ "$PG_ARTIFACT" == http* ]]; then
    pg_tmp="$(mktemp)"
    trap 'rm -f "$pg_tmp"' EXIT
    log "downloading embedded PostgreSQL artifact"
    curl -fsSL "$PG_ARTIFACT" -o "$pg_tmp" || die "failed to download $PG_ARTIFACT"
  fi
  if node "$APP_DIR/scripts/embedded-pg.mjs" info >/dev/null 2>&1; then
    log "embedded PostgreSQL already installed; skipping (--pg-artifact kept as update path)"
  else
    log "installing embedded PostgreSQL 17 + pgvector (user directory, no sudo)"
    node "$APP_DIR/scripts/embedded-pg.mjs" install --artifact "$pg_tmp" \
      || die "embedded PostgreSQL install failed"
  fi
  [[ "$PG_ARTIFACT" == http* ]] && { rm -f "$pg_tmp"; trap - EXIT; }
fi

# --- 5. Hand off to the interactive web bootstrap -------------------------------
if [[ "${REALM_INSTALL_SKIP_SETUP:-0}" == 1 ]]; then
  log "REALM_INSTALL_SKIP_SETUP=1 → stopping before setup-web"
  exit 0
fi
exec bash "$APP_DIR/scripts/setup-web.sh" "${SETUP_ARGS[@]}"
