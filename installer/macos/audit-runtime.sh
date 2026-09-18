#!/usr/bin/env bash
# Reject non-system dynamic dependencies in the bundled macOS PG runtime.
set -euo pipefail

PG_ROOT="${1:?usage: $0 <pgsql-root>}"
for command_name in find file otool awk grep; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required macOS audit command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

[[ -d "$PG_ROOT/bin" && -d "$PG_ROOT/lib" ]] || {
  printf 'invalid PostgreSQL runtime root: %s\n' "$PG_ROOT" >&2
  exit 1
}

found=0
while IFS= read -r candidate; do
  if ! file "$candidate" | grep -Fq "Mach-O"; then
    continue
  fi
  found=1
  bad_dependencies="$(
    otool -L "$candidate" \
      | awk 'NR > 1 { print $1 }' \
      | grep -Ev '^(\/usr\/lib\/|\/System\/Library\/|@rpath\/|@loader_path\/|@executable_path\/)' \
      || true
  )"
  if [[ -n "$bad_dependencies" ]]; then
    printf 'non-portable dependency in %s:\n%s\n' "$candidate" "$bad_dependencies" >&2
    exit 1
  fi
done < <(find "$PG_ROOT/bin" "$PG_ROOT/lib" -type f -print)

[[ "$found" -eq 1 ]] || {
  printf 'no Mach-O files found under %s\n' "$PG_ROOT" >&2
  exit 1
}
printf 'macOS PostgreSQL dynamic dependency audit passed: %s\n' "$PG_ROOT"
