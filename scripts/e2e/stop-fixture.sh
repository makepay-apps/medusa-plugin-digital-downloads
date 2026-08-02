#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_ROOT/lib.sh"

[[ $# -eq 1 ]] || e2e_die "Usage: $0 /absolute/path/to/fixture/runtime/run-id"
run_root="$1"
[[ "$run_root" = /* ]] || e2e_die "Run directory must be absolute"
[[ -d "$run_root" ]] || e2e_die "Run directory does not exist: ${run_root}"
e2e_assert_fixture_descendant "$E2E_RUNTIME_ROOT" "Runtime directory"
canonical_runtime="$(cd "$E2E_RUNTIME_ROOT" && pwd -P)"
[[ ! -L "$run_root" ]] || e2e_die "Run directory itself must not be a symlink"
canonical_run="$(cd "$run_root" && pwd -P)"
[[ "$(dirname "$canonical_run")" == "$canonical_runtime" ]] || \
  e2e_die "Run directory must be immediately below ${E2E_RUNTIME_ROOT}"
run_name="$(basename "$canonical_run")"
[[ "$run_name" =~ ^[0-9]{8}T[0-9]{6}Z-(local|s3)-[0-9]+$ ]] || \
  e2e_die "Run directory name is not a packed-E2E run identifier"
owner_marker="$canonical_run/.owned-by-packed-e2e"
[[ -f "$owner_marker" && ! -L "$owner_marker" ]] || \
  e2e_die "Run directory is missing its ownership marker"
[[ "$(tr -d '\r\n' <"$owner_marker")" == "makepay-digital-downloads-packed-e2e-v1" ]] || \
  e2e_die "Run ownership marker is invalid"
run_root="$canonical_run"

owned_command_matches() {
  local name="$1"
  local command="$2"
  local launch_fragment="$3"
  [[ "$command" == *"$launch_fragment"* ]] && return 0
  # Next replaces argv through process.title after startup. Accept only its
  # tightly shaped title for a storefront PID whose recorded start also matches.
  [[ "$name" == "storefront" && \
    "$command" =~ ^[[:space:]]*next-server[[:space:]]+\(v[0-9A-Za-z.+-]+\)[[:space:]]*$ ]]
}

owned_process_command_matches() {
  local name="$1"
  local command="$2"
  local launch_fragment="$3"
  local sealed_file="${run_root}/${name}.command"
  if [[ -e "$sealed_file" ]]; then
    [[ -f "$sealed_file" && ! -L "$sealed_file" ]] || return 1
    local sealed_command
    sealed_command="$(tr -d '\r\n' <"$sealed_file")"
    if [[ -n "$sealed_command" && "$command" == "$sealed_command" ]]; then
      return 0
    fi
    return 1
  fi
  owned_command_matches "$name" "$command" "$launch_fragment"
}

stop_recorded() {
  local name="$1"
  local expected_fragment="$2"
  local pid_file="$run_root/${name}.pid"
  local started_file="$run_root/${name}.started"
  [[ -e "$pid_file" || -e "$started_file" ]] || return 0
  [[ -f "$pid_file" && ! -L "$pid_file" ]] || e2e_die "Invalid PID file: ${pid_file}"
  [[ -f "$started_file" && ! -L "$started_file" ]] || e2e_die "Invalid process identity file: ${started_file}"
  local pid
  pid="$(tr -d '[:space:]' <"$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || e2e_die "Invalid PID file: ${pid_file}"
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  local command
  command="$(ps -p "$pid" -o command=)"
  owned_process_command_matches "$name" "$command" "$expected_fragment" || \
    e2e_die "PID ${pid} no longer belongs to the expected ${name} command"
  local recorded_start current_start
  recorded_start="$(tr -d '\r\n' <"$started_file")"
  current_start="$(ps -p "$pid" -o lstart= | tr -d '\r\n')"
  [[ -n "$recorded_start" && "$current_start" == "$recorded_start" ]] || \
    e2e_die "PID ${pid} start identity no longer matches the recorded ${name} process"
  e2e_stop_owned_process "$pid" "$name" "$recorded_start"
}

stop_recorded "storefront" "node_modules/.bin/next start --hostname 127.0.0.1 --port 8000"
stop_recorded "backend" "node_modules/.bin/medusa start --host 127.0.0.1 --port 9100"
stop_recorded "minio" "minio server"
lock_root="$canonical_runtime/.packed-e2e.lock"
lock_entry="$lock_root/$run_name"
if [[ -d "$lock_root" && ! -L "$lock_root" ]]; then
  [[ -d "$lock_entry" && ! -L "$lock_entry" ]] || \
    e2e_die "Fixture lock belongs to another or incomplete packed-E2E run"
  rmdir "$lock_entry"
  rmdir "$lock_root"
fi
e2e_log "Stopped all still-running processes recorded by ${run_root}"
