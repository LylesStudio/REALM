#!/usr/bin/env bash
# Build a complete unsigned REALM macOS preview DMG without mutating the repo.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/desktop/package-macos.sh [options]

Options:
  --arch arm64|x64|darwin-arm64|darwin-x64
  --output DIRECTORY    Artifact directory (default: outputs/macos)
  --help

The script packages the current committed HEAD in a disposable git worktree.
It does not include uncommitted files and does not read model credentials.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

requested_arch=""
output_dir="outputs/macos"
while (($# > 0)); do
  case "$1" in
    --arch)
      [[ $# -ge 2 ]] || { printf '%s\n' '--arch requires a value' >&2; exit 2; }
      requested_arch="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { printf '%s\n' '--output requires a directory' >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || {
  printf '%s\n' 'macOS packaging must run on Darwin; Linux cannot produce a real DMG.' >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf '%s\n' 'run this script from a REALM git checkout.' >&2
  exit 1
}

[[ -z "$(git -C "$repo_root" status --porcelain)" ]] || {
  printf '%s\n' 'working tree is not clean; commit or separately preserve changes before packaging.' >&2
  exit 1
}

case "$(uname -m)" in
  arm64) host_arch="arm64" ;;
  x86_64) host_arch="x64" ;;
  *)
    printf 'unsupported macOS host architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

case "${requested_arch:-$host_arch}" in
  arm64|darwin-arm64) arch="arm64"; arch_tag="darwin-arm64"; ;;
  x64|darwin-x64) arch="x64"; arch_tag="darwin-x64"; ;;
  *)
    printf 'unsupported packaging architecture: %s\n' "${requested_arch:-$host_arch}" >&2
    exit 2
    ;;
esac

[[ "$arch" == "$host_arch" ]] || {
  printf 'architecture mismatch: requested %s on %s; run under the matching native macOS process or runner.\n' "$arch" "$host_arch" >&2
  exit 1
}

for command_name in git node npm curl shasum tar make clang install_name_tool otool file hdiutil tail; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required macOS packaging command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node >=22.13.0 is required; got ${process.versions.node}`);
  process.exit(1);
}
'

if [[ "$output_dir" != /* ]]; then
  output_dir="$repo_root/$output_dir"
fi
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

commit="$(git -C "$repo_root" rev-parse HEAD)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/realm-macos-package.XXXXXX")"
source_root="$tmp_root/source"
build_root="$tmp_root/build"
cleanup() {
  status=$?
  cd "$repo_root" || true
  git -C "$repo_root" worktree remove --force "$source_root" >/dev/null 2>&1 || true
  if [[ -d "$tmp_root" ]]; then
    rm -rf "$tmp_root"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

printf 'REALM macOS package\n'
printf '  architecture: %s\n' "$arch_tag"
printf '  source: %s\n' "$commit"
printf '  output: %s\n' "$output_dir"

git -C "$repo_root" worktree add --detach "$source_root" "$commit"
mkdir -p "$build_root"
cd "$source_root"

printf '%s\n' '[1/9] install production inputs'
npm ci --ignore-scripts

printf '%s\n' '[2/9] build application'
npm run build

printf '%s\n' '[3/9] generate production SBOM and prune development dependencies'
npm sbom --sbom-format cyclonedx --sbom-type application --omit=dev \
  > "$build_root/SBOM.cdx.json"
npm prune --omit=dev --ignore-scripts

printf '%s\n' '[4/9] build PostgreSQL + pgvector'
bash installer/macos/build-postgresql-and-pgvector.sh "$build_root" "$arch_tag"

printf '%s\n' '[5/9] audit PostgreSQL dependencies'
bash installer/macos/audit-runtime.sh "$build_root/pgsql/$arch_tag"

printf '%s\n' '[6/9] assemble app bundle'
node scripts/desktop/bundle-macos.mjs "$build_root" "$arch_tag"

printf '%s\n' '[7/9] audit bundled Node and run fresh-data smoke'
bash installer/macos/audit-runtime.sh \
  "$build_root/REALM.app/Contents/Resources/runtime/node/$arch_tag"
smoke_data="$build_root/smoke-data"
if ! "$build_root/REALM.app/Contents/MacOS/REALM" \
  --check \
  --data-home "$smoke_data"; then
  printf '%s\n' 'fresh-data smoke launcher failed; launcher log follows:' >&2
  if [[ -f "$smoke_data/logs/launcher.log" ]]; then
    tail -n 200 "$smoke_data/logs/launcher.log" >&2
  else
    printf 'launcher log was not created: %s\n' "$smoke_data/logs/launcher.log" >&2
  fi
  exit 1
fi
[[ ! -e "$smoke_data/realm.lock" ]] || {
  printf 'fresh-data smoke left an instance lock: %s\n' "$smoke_data/realm.lock" >&2
  exit 1
}
[[ -f "$smoke_data/postgres/data/PG_VERSION" ]] || {
  printf 'fresh-data smoke did not initialize PG_VERSION: %s\n' \
    "$smoke_data/postgres/data/PG_VERSION" >&2
  exit 1
}
[[ -f "$smoke_data/postgres/.realm-transfer-password" ]] || {
  printf 'fresh-data smoke did not provision realm_transfer: %s\n' \
    "$smoke_data/postgres/.realm-transfer-password" >&2
  exit 1
}

printf '%s\n' '[8/9] create DMG'
artifact="$output_dir/realm-${arch_tag}-unsigned-preview.dmg"
node scripts/desktop/make-macos-dmg.mjs \
  "$build_root/REALM.app" \
  "$artifact"

printf '%s\n' '[9/9] publish local artifact metadata'
shasum -a 256 "$artifact" > "$output_dir/realm-${arch_tag}-SHA256.txt"
cp installer/macos/inventory.json "$output_dir/inventory.json"
cp installer/macos/README.md "$output_dir/README-macos-unsigned-preview.md"
cp "$build_root/SBOM.cdx.json" "$output_dir/SBOM.cdx.json"

printf 'macOS artifact ready: %s\n' "$artifact"
printf 'SHA256 file: %s\n' "$output_dir/realm-${arch_tag}-SHA256.txt"
