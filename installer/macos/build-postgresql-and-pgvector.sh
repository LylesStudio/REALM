#!/usr/bin/env bash
# Build the pinned macOS PostgreSQL + pgvector runtime for one runner architecture.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <work-dir> <darwin-arm64|darwin-x64>\n' "$0" >&2
  exit 2
fi

WORK_DIR="$1"
ARCH_TAG="$2"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY="$PROJECT_ROOT/installer/macos/inventory.json"

case "$ARCH_TAG" in
  darwin-arm64) EXPECTED_MACHINE="arm64" ;;
  darwin-x64) EXPECTED_MACHINE="x86_64" ;;
  *)
    printf 'unsupported macOS architecture tag: %s\n' "$ARCH_TAG" >&2
    exit 2
    ;;
esac

for command_name in curl shasum tar git make clang install_name_tool otool file codesign; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required macOS build command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

if [[ "$(uname -m)" != "$EXPECTED_MACHINE" ]]; then
  printf 'runner architecture mismatch: expected %s, got %s\n' "$EXPECTED_MACHINE" "$(uname -m)" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
OPENSSL_ROOT="${REALM_OPENSSL_ROOT:-}"
if [[ -z "$OPENSSL_ROOT" ]] && command -v brew >/dev/null 2>&1; then
  OPENSSL_ROOT="$(brew --prefix openssl@3 2>/dev/null || true)"
fi
if [[ -z "$OPENSSL_ROOT" ]]; then
  for candidate in /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3; do
    if [[ -f "$candidate/include/openssl/evp.h" ]]; then
      OPENSSL_ROOT="$candidate"
      break
    fi
  done
fi
[[ -f "$OPENSSL_ROOT/include/openssl/evp.h" ]] || {
  printf 'OpenSSL 3 headers not found; install openssl@3 or set REALM_OPENSSL_ROOT\n' >&2
  exit 1
}
OPENSSL_ROOT="$(cd "$OPENSSL_ROOT" && pwd -P)"
PG_VERSION="$(node -e 'const i=require(process.argv[1]); process.stdout.write(i.postgresql.version)' "$INVENTORY")"
PG_URL="$(node -e 'const i=require(process.argv[1]); process.stdout.write(i.postgresql.url)' "$INVENTORY")"
PG_SHA256="$(node -e 'const i=require(process.argv[1]); process.stdout.write(i.postgresql.sha256)' "$INVENTORY")"
PGVECTOR_TAG="$(node -e 'const i=require(process.argv[1]); process.stdout.write(i.pgvector.tag)' "$INVENTORY")"
PGVECTOR_COMMIT="$(node -e 'const i=require(process.argv[1]); process.stdout.write(i.pgvector.commit)' "$INVENTORY")"
PG_ROOT="$WORK_DIR/pgsql/$ARCH_TAG"
PG_ARCHIVE="$WORK_DIR/postgresql-$PG_VERSION.tar.gz"
PG_SOURCE="$WORK_DIR/postgresql-$PG_VERSION"
VECTOR_SOURCE="$WORK_DIR/pgvector-$PGVECTOR_TAG"

if [[ ! -f "$PG_ARCHIVE" ]]; then
  curl --http1.1 --connect-timeout 15 --max-time 120 --retry-max-time 120 --retry 4 --retry-all-errors --retry-delay 2 -fsSL -o "$PG_ARCHIVE" "$PG_URL"
fi
printf '%s  %s\n' "$PG_SHA256" "$PG_ARCHIVE" | shasum -a 256 -c -

rm -rf "$PG_SOURCE" "$PG_ROOT" "$VECTOR_SOURCE"
tar -xzf "$PG_ARCHIVE" -C "$WORK_DIR"
[[ -d "$PG_SOURCE" ]] || {
  printf 'PostgreSQL source directory missing after extraction: %s\n' "$PG_SOURCE" >&2
  exit 1
}

mkdir -p "$PG_ROOT"
pushd "$PG_SOURCE" >/dev/null
./configure \
  CC=clang \
  --prefix="$PG_ROOT" \
  --without-icu \
  --without-readline \
  --with-zlib \
  --without-openssl \
  --disable-nls
CPU_COUNT="$(sysctl -n hw.ncpu 2>/dev/null || printf '2')"
make -j"$CPU_COUNT"
make install
popd >/dev/null

# pgcrypto links against the runner's OpenSSL. Copy only the required shared
# libraries into the bundle and normalize their IDs/dependencies below.
for library in "$OPENSSL_ROOT"/lib/libcrypto.3.dylib; do
  [[ -f "$library" ]] || continue
  bundled_library="$PG_ROOT/lib/$(basename "$library")"
  cp -p "$library" "$bundled_library"
done

# The application migrations require DB-side digest()/encode() from pgcrypto.
# Build it against this exact PostgreSQL tree; installing core alone does not
# install contrib extensions.
make -C "$PG_SOURCE/contrib/pgcrypto" \
  PG_CONFIG="$PG_ROOT/bin/pg_config" \
  CPPFLAGS="-I$OPENSSL_ROOT/include" \
  LDFLAGS="-L$OPENSSL_ROOT/lib" \
  LIBS="-lcrypto -lz"
make -C "$PG_SOURCE/contrib/pgcrypto" install \
  PG_CONFIG="$PG_ROOT/bin/pg_config" \
  CPPFLAGS="-I$OPENSSL_ROOT/include" \
  LDFLAGS="-L$OPENSSL_ROOT/lib" \
  LIBS="-lcrypto -lz"

# Build pgvector against this exact PostgreSQL installation, never a Homebrew pg_config.
git clone --depth 1 --branch "$PGVECTOR_TAG" \
  https://github.com/pgvector/pgvector.git "$VECTOR_SOURCE"
ACTUAL_VECTOR_COMMIT="$(git -C "$VECTOR_SOURCE" rev-parse HEAD)"
[[ "$ACTUAL_VECTOR_COMMIT" == "$PGVECTOR_COMMIT" ]] || {
  printf 'pgvector commit mismatch: expected %s, got %s\n' "$PGVECTOR_COMMIT" "$ACTUAL_VECTOR_COMMIT" >&2
  exit 1
}
pushd "$VECTOR_SOURCE" >/dev/null
make PG_CONFIG="$PG_ROOT/bin/pg_config"
make PG_CONFIG="$PG_ROOT/bin/pg_config" install
popd >/dev/null

# Make the installed PostgreSQL tree movable from the CI temp directory into
# REALM.app. PostgreSQL installs absolute references to its private libraries
# in both executables and loadable modules, so every Mach-O file under bin/lib
# must be normalized rather than only the top-level dylibs.
for library in "$PG_ROOT"/lib/*.dylib; do
  [[ -e "$library" ]] || continue
  install_name_tool -id "@rpath/$(basename "$library")" "$library"
done

while IFS= read -r candidate; do
  file "$candidate" | grep -Fq "Mach-O" || continue

  while IFS= read -r dependency; do
    case "$dependency" in
      "$PG_ROOT/lib/"*|"$OPENSSL_ROOT/lib/"*|*/openssl@3/*) ;;
      *) continue ;;
    esac
    install_name_tool -change "$dependency" \
      "@rpath/$(basename "$dependency")" "$candidate"
  done < <(otool -L "$candidate" | awk 'NR > 1 { print $1 }')

  case "$candidate" in
    "$PG_ROOT"/bin/*) runtime_rpath="@loader_path/../lib" ;;
    "$PG_ROOT"/lib/postgresql/*) runtime_rpath="@loader_path/.." ;;
    "$PG_ROOT"/lib/*) runtime_rpath="@loader_path" ;;
    *) continue ;;
  esac
  if ! otool -l "$candidate" | grep -Fq "$runtime_rpath"; then
    install_name_tool -add_rpath "$runtime_rpath" "$candidate"
  fi
done < <(find "$PG_ROOT/bin" "$PG_ROOT/lib" -type f -print)

# install_name_tool invalidates Homebrew's signature. Replace it with an
# ad-hoc signature so macOS accepts libcrypto when pgcrypto is loaded.
if [[ -f "$PG_ROOT/lib/libcrypto.3.dylib" ]]; then
  codesign --force --sign - --timestamp=none "$PG_ROOT/lib/libcrypto.3.dylib" >/dev/null
fi

[[ -x "$PG_ROOT/bin/initdb" ]] || { printf 'initdb missing\n' >&2; exit 1; }
[[ -x "$PG_ROOT/bin/postgres" ]] || { printf 'postgres missing\n' >&2; exit 1; }
[[ -f "$PG_ROOT/lib/vector.dylib" ]] || { printf 'pgvector vector.dylib missing\n' >&2; exit 1; }
[[ -f "$PG_ROOT/share/extension/vector.control" ]] || { printf 'pgvector control file missing\n' >&2; exit 1; }
compgen -G "$PG_ROOT/share/extension/vector--*.sql" >/dev/null || {
  printf 'pgvector SQL migration files missing\n' >&2
  exit 1
}

printf 'built PostgreSQL %s + pgvector %s for %s\n' "$PG_VERSION" "$PGVECTOR_TAG" "$ARCH_TAG"
