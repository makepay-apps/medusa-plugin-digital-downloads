#!/usr/bin/env bash

# Shared helpers for the disposable packed-plugin fixture. This file is sourced
# by the entrypoint and is not intended to be executed directly.

set -o errexit
set -o nounset
set -o pipefail

[[ -n "${E2E_FIXTURE_ROOT:-}" ]] || {
  printf '[packed-e2e] ERROR: E2E_FIXTURE_ROOT must name the disposable fixture root\n' >&2
  exit 1
}
[[ "$E2E_FIXTURE_ROOT" = /* ]] || {
  printf '[packed-e2e] ERROR: E2E_FIXTURE_ROOT must be absolute\n' >&2
  exit 1
}
E2E_FIXTURE_ROOT="$(cd "$E2E_FIXTURE_ROOT" 2>/dev/null && pwd -P)" || {
  printf '[packed-e2e] ERROR: E2E_FIXTURE_ROOT does not exist\n' >&2
  exit 1
}
export E2E_FIXTURE_ROOT
readonly E2E_FIXTURE_ROOT
readonly E2E_APP_ROOT="${E2E_FIXTURE_ROOT}/medusa-app"
readonly E2E_BACKEND_ROOT="${E2E_APP_ROOT}/apps/backend"
readonly E2E_STOREFRONT_ROOT="${E2E_APP_ROOT}/apps/storefront"
readonly E2E_MINIO_ROOT="${E2E_FIXTURE_ROOT}/minio"
readonly E2E_RUNTIME_ROOT="${E2E_FIXTURE_ROOT}/runtime"

e2e_log() {
  printf '[packed-e2e] %s\n' "$*"
}

e2e_die() {
  printf '[packed-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

e2e_require_file() {
  local target="$1"
  [[ -f "$target" ]] || e2e_die "Required file is missing: ${target}"
}

e2e_require_directory() {
  local target="$1"
  [[ -d "$target" ]] || e2e_die "Required directory is missing: ${target}"
}

e2e_require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || \
    e2e_die "Required command is unavailable: ${command_name}"
}

e2e_realpath() {
  node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$1"
}

e2e_assert_fixture_descendant() {
  local target="$1"
  local label="${2:-Path}"
  local canonical_target
  canonical_target="$(e2e_realpath "$target")" || \
    e2e_die "${label} cannot be resolved safely: ${target}"
  case "$canonical_target" in
    "$E2E_FIXTURE_ROOT"/*) ;;
    *) e2e_die "${label} resolves outside E2E_FIXTURE_ROOT: ${target}" ;;
  esac
}

e2e_assert_fixture_layout() {
  local require_storefront="${1:-true}"
  e2e_require_command node
  e2e_require_command rg
  local canonical_fixture="$E2E_FIXTURE_ROOT"
  local canonical_repository_root
  canonical_repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  local canonical_user_home
  canonical_user_home="$(cd "${HOME:?}" && pwd -P)"
  case "$canonical_fixture" in
    /|/Users|/home|/tmp|/private/tmp|/var|/private/var|/Volumes|"$canonical_user_home"|"$canonical_repository_root")
      e2e_die "E2E_FIXTURE_ROOT is too broad or points at a protected working directory"
      ;;
  esac
  e2e_require_directory "$E2E_APP_ROOT"
  e2e_assert_fixture_descendant "$E2E_APP_ROOT" "Medusa fixture"
  e2e_require_directory "$E2E_BACKEND_ROOT"
  e2e_assert_fixture_descendant "$E2E_BACKEND_ROOT" "Backend fixture"
  if [[ "$require_storefront" == "true" ]]; then
    e2e_require_directory "$E2E_STOREFRONT_ROOT"
    e2e_assert_fixture_descendant "$E2E_STOREFRONT_ROOT" "Storefront fixture"
    e2e_require_file "$E2E_STOREFRONT_ROOT/.env.local"
    e2e_assert_fixture_descendant "$E2E_STOREFRONT_ROOT/.env.local" "Storefront environment"
  fi
  e2e_require_directory "$E2E_MINIO_ROOT"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT" "MinIO fixture"
  e2e_require_directory "$E2E_MINIO_ROOT/data"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/data" "MinIO data"
  e2e_require_directory "$E2E_MINIO_ROOT/home"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/home" "MinIO home"
  e2e_require_directory "$E2E_MINIO_ROOT/logs"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/logs" "MinIO logs"
  e2e_require_file "$E2E_BACKEND_ROOT/medusa-config.ts"
  e2e_assert_fixture_descendant "$E2E_BACKEND_ROOT/medusa-config.ts" "Backend config"
  e2e_require_file "$E2E_BACKEND_ROOT/.env"
  e2e_assert_fixture_descendant "$E2E_BACKEND_ROOT/.env" "Backend environment"
  e2e_require_file "$E2E_MINIO_ROOT/minio.env"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/minio.env" "MinIO environment"
  e2e_require_file "$E2E_MINIO_ROOT/minio"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/minio" "MinIO executable"
  if [[ -e "$E2E_RUNTIME_ROOT" || -L "$E2E_RUNTIME_ROOT" ]]; then
    e2e_require_directory "$E2E_RUNTIME_ROOT"
    e2e_assert_fixture_descendant "$E2E_RUNTIME_ROOT" "Runtime directory"
  fi
  e2e_require_directory "$E2E_FIXTURE_ROOT/storage"
  e2e_assert_fixture_descendant "$E2E_FIXTURE_ROOT/storage" "Local storage"
  e2e_require_file "$E2E_APP_ROOT/FIXTURE.md"
  e2e_assert_fixture_descendant "$E2E_APP_ROOT/FIXTURE.md" "Fixture marker"
  rg -q "Digital Downloads E2E Fixture" "$E2E_APP_ROOT/FIXTURE.md" || \
    e2e_die "Fixture marker did not identify the disposable digital-downloads fixture"
}

e2e_assert_port_unused() {
  local port="$1"
  e2e_require_command lsof
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    e2e_die "TCP port ${port} is already occupied; refusing to stop or reuse an unowned process"
  fi
}

e2e_wait_http() {
  local url="$1"
  local attempts="${2:-120}"
  local delay="${3:-0.5}"
  e2e_require_command curl
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  e2e_die "Timed out waiting for ${url}"
}

e2e_run_bounded() {
  local timeout_seconds="$1"
  shift
  node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/run-command-with-timeout.mjs" \
    "$timeout_seconds" "$@"
}

e2e_stop_owned_process() {
  local pid="${1:-}"
  local label="${2:-process}"
  local expected_start="${3:-}"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  local current_start
  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\r\n')"
  if [[ -z "$expected_start" || "$current_start" != "$expected_start" ]]; then
    e2e_log "Refusing to signal ${label} PID ${pid}; its start identity changed"
    return 0
  fi

  e2e_log "Stopping owned ${label} process (${pid})"
  kill -TERM "$pid" >/dev/null 2>&1 || true
  local attempt
  for ((attempt = 1; attempt <= 40; attempt += 1)); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.25
  done

  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\r\n')"
  if [[ "$current_start" != "$expected_start" ]]; then
    e2e_log "Refusing to force-stop ${label} PID ${pid}; its start identity changed"
    return 0
  fi
  kill -KILL "$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
}
