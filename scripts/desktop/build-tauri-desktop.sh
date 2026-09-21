#!/usr/bin/env bash
set -euo pipefail

# Desktop bundle recipe. The staging script receives only explicitly supplied
# runtime paths; it never reads .env.local or copies user data.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-linux}"
shift || true

cd "$ROOT"
npm run build
node scripts/desktop/prepare-tauri-resources.mjs "$TARGET"
CONFIG="src-tauri/tauri.${TARGET}.bundle.conf.json"
if [[ ! -f "$CONFIG" ]]; then
  printf 'missing Tauri bundle overlay: %s\n' "$CONFIG" >&2
  exit 2
fi
case "$TARGET" in
  linux)  exec cargo tauri build --config "$CONFIG" --bundles deb,rpm "$@" ;;
  windows|macos) exec cargo tauri build --config "$CONFIG" "$@" ;;
  *) printf 'unsupported Tauri desktop target: %s\n' "$TARGET" >&2; exit 2 ;;
esac
