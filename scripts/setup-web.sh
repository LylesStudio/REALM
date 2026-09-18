#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO_YES=0
for arg in "$@"; do
  [[ "$arg" == "--yes" ]] && AUTO_YES=1
done

node_ok=0
if command -v node >/dev/null 2>&1; then
  node_ok="$(node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=13) ? 0 : 1)' && printf 1 || printf 0)"
fi
if [[ "$node_ok" != 1 ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 22.13+ is required. Install Homebrew or Node.js, then rerun this script.' >&2
    exit 1
  fi
  if [[ "$AUTO_YES" != 1 ]]; then
    read -r -p 'Node.js 22.13+ is missing. Install it with Homebrew? [y/N] ' answer
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || exit 1
  fi
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi

exec node "$ROOT/scripts/setup-web.mjs" "$@"
