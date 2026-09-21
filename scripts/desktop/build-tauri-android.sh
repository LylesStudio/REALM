#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Prefer audited user-local Android tools when the shell has not configured them.
if [[ -z "${JAVA_HOME:-}" && -x "$HOME/.local/jdk-17/bin/java" ]]; then
  export JAVA_HOME="$HOME/.local/jdk-17"
fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/.local/android-sdk" ]]; then
  export ANDROID_HOME="$HOME/.local/android-sdk"
fi
if [[ -z "${ANDROID_SDK_ROOT:-}" && -n "${ANDROID_HOME:-}" ]]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
if [[ -z "${NDK_HOME:-}" && -d "${ANDROID_HOME:-}/ndk/27.0.12077973" ]]; then
  export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
if [[ -n "${ANDROID_HOME:-}" ]]; then export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"; fi
if [[ -n "${NDK_HOME:-}" ]]; then export ANDROID_NDK_HOME="$NDK_HOME"; fi

npm run desktop:android:prepare
exec cargo +stable tauri android build --apk --target aarch64
