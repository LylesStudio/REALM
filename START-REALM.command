#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
bash "$ROOT/scripts/setup-web.sh" "$@"
status=$?

if [ "$status" -ne 0 ]; then
  printf '\nREALM did not start. Read the message above, then press Enter to close.\n'
  read -r _
fi

exit "$status"
