#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_ROOT/lib.sh"

usage() {
  printf '%s\n' \
    "Usage: $0 --tarball /absolute/path/package.tgz [--storage local|s3] [--keep-running] [--skip-storefront]" \
    "" \
    "E2E_FIXTURE_ROOT must be exported and point to the marked disposable fixture." \
    "Runs only against the disposable fixture on backend :9100, storefront :8000," \
    "PostgreSQL :55432, and (for S3 mode) MinIO :9400. It never probes, starts," \
    "stops, or modifies the long-running Medusa installation on :9000."
}

tarball=""
storage_provider="local"
keep_running="false"
run_storefront="true"

while (($# > 0)); do
  case "$1" in
    --tarball)
      (($# >= 2)) || e2e_die "--tarball requires a value"
      tarball="$2"
      shift 2
      ;;
    --storage)
      (($# >= 2)) || e2e_die "--storage requires local or s3"
      storage_provider="$2"
      shift 2
      ;;
    --keep-running)
      keep_running="true"
      shift
      ;;
    --skip-storefront)
      run_storefront="false"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      e2e_die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$tarball" ]] || e2e_die "--tarball is required"
[[ "$tarball" = /* ]] || e2e_die "--tarball must be an absolute path"
[[ "$storage_provider" == "local" || "$storage_provider" == "s3" ]] || \
  e2e_die "--storage must be local or s3"

for required_command in node openssl pg_isready pnpm ps curl lsof; do
  e2e_require_command "$required_command"
done

e2e_assert_fixture_layout "$run_storefront"
e2e_require_file "$tarball"
umask 077
mkdir -p "$E2E_RUNTIME_ROOT"
e2e_assert_fixture_descendant "$E2E_RUNTIME_ROOT" "Runtime directory"
chmod 700 "$E2E_RUNTIME_ROOT"

backend_pid=""
storefront_pid=""
minio_pid=""
lock_root="${E2E_RUNTIME_ROOT}/.packed-e2e.lock"
lock_entry=""
lock_owned="false"
run_root=""

release_lock() {
  [[ "$lock_owned" == "true" ]] || return 0
  if [[ -n "$lock_entry" && -d "$lock_entry" && ! -L "$lock_entry" ]]; then
    rmdir "$lock_entry"
  fi
  if [[ -d "$lock_root" && ! -L "$lock_root" ]]; then
    rmdir "$lock_root"
  fi
  lock_owned="false"
}

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

cleanup_recorded_process() {
  local pid="${1:-}"
  local name="$2"
  local expected_fragment="$3"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  local started_file="${run_root}/${name}.started"
  if [[ ! -f "$started_file" || -L "$started_file" ]]; then
    e2e_log "Refusing to stop PID ${pid}: ${name} identity record is unavailable"
    return 0
  fi
  local command recorded_start current_start
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  recorded_start="$(tr -d '\r\n' <"$started_file")"
  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\r\n')"
  if ! owned_process_command_matches "$name" "$command" "$expected_fragment" || \
    [[ -z "$recorded_start" || "$current_start" != "$recorded_start" ]]; then
    e2e_log "Refusing to stop PID ${pid}: recorded ${name} identity no longer matches"
    return 0
  fi
  e2e_stop_owned_process "$pid" "$name" "$recorded_start"
}

cleanup_services() {
  cleanup_recorded_process "$storefront_pid" "storefront" \
    "node_modules/.bin/next start --hostname 127.0.0.1 --port 8000"
  cleanup_recorded_process "$backend_pid" "backend" \
    "node_modules/.bin/medusa start --host 127.0.0.1 --port 9100"
  cleanup_recorded_process "$minio_pid" "minio" "minio server"
}

cleanup_on_exit() {
  local status=$?
  if [[ "$keep_running" != "true" || $status -ne 0 ]]; then
    cleanup_services
    release_lock
  fi
}

cleanup_on_signal() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup_services
  release_lock
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'cleanup_on_signal 130' INT
trap 'cleanup_on_signal 143' TERM

mkdir "$lock_root" 2>/dev/null || \
  e2e_die "Another packed E2E run owns this fixture; stop it before starting a new run"
lock_owned="true"

e2e_assert_port_unused 9100
if [[ "$run_storefront" == "true" ]]; then
  e2e_assert_port_unused 8000
fi
if [[ "$storage_provider" == "s3" ]]; then
  e2e_assert_port_unused 9400
  e2e_assert_port_unused 9401
fi

run_id="$(date -u '+%Y%m%dT%H%M%SZ')-${storage_provider}-$$"
run_root="${E2E_RUNTIME_ROOT}/${run_id}"
mkdir "$run_root"
chmod 700 "$run_root"
notification_capture_root="${run_root}/notifications"
mkdir -p \
  "$notification_capture_root/attempts" \
  "$notification_capture_root/captures"
e2e_assert_fixture_descendant "$notification_capture_root" \
  "Notification capture directory"
chmod 700 \
  "$notification_capture_root" \
  "$notification_capture_root/attempts" \
  "$notification_capture_root/captures"
lock_entry="${lock_root}/${run_id}"
mkdir "$lock_entry"

printf '%s\n' "makepay-digital-downloads-packed-e2e-v1" >"$run_root/.owned-by-packed-e2e"
chmod 600 "$run_root/.owned-by-packed-e2e"

record_process() {
  local name="$1"
  local pid="$2"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || e2e_die "${name} launcher returned an invalid PID"
  kill -0 "$pid" >/dev/null 2>&1 || e2e_die "${name} exited before its PID could be recorded"
  printf '%s\n' "$pid" >"$run_root/${name}.pid"
  ps -p "$pid" -o lstart= >"$run_root/${name}.started"
  [[ -s "$run_root/${name}.started" ]] || e2e_die "${name} start identity is unavailable"
  chmod 600 "$run_root/${name}.pid" "$run_root/${name}.started"
}

launch_detached() {
  local log_path="$1"
  shift
  node "$SCRIPT_ROOT/launch-detached.mjs" "$log_path" "$@"
}

seal_process_identity() {
  local name="$1"
  local pid="$2"
  local recorded_start current_start command
  recorded_start="$(tr -d '\r\n' <"$run_root/${name}.started")"
  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\r\n')"
  command="$(ps -p "$pid" -o command= 2>/dev/null | tr -d '\r\n')"
  [[ -n "$recorded_start" && "$current_start" == "$recorded_start" ]] || \
    e2e_die "${name} PID identity changed before readiness"
  [[ -n "$command" ]] || e2e_die "${name} command identity is unavailable"
  printf '%s\n' "$command" >"$run_root/${name}.command"
  chmod 600 "$run_root/${name}.command"
}

FIXTURE_DIGITAL_DOWNLOADS_PRIVACY_SALT=""
FIXTURE_MINIO_BROWSER="off"
FIXTURE_NEXT_PUBLIC_DEFAULT_REGION="dk"
FIXTURE_NEXT_PUBLIC_BASE_URL="http://127.0.0.1:8000"
FIXTURE_NEXT_PUBLIC_STRIPE_KEY=""
FIXTURE_MEDUSA_CLOUD_S3_HOSTNAME=""
FIXTURE_MEDUSA_CLOUD_S3_PATHNAME=""
if [[ "$run_storefront" == "true" ]]; then
  fixture_env_records="$(node "$SCRIPT_ROOT/read-fixture-env.mjs")" || \
    e2e_die "Fixture environment validation failed"
else
  fixture_env_records="$(node "$SCRIPT_ROOT/read-fixture-env.mjs" --skip-storefront)" || \
    e2e_die "Fixture environment validation failed"
fi
while IFS=$'\t' read -r fixture_name fixture_encoded; do
  [[ -n "$fixture_name" ]] || continue
  [[ "$fixture_name" =~ ^FIXTURE_[A-Z][A-Z0-9_]*$ ]] || \
    e2e_die "Fixture environment reader returned an invalid key"
  fixture_value="$(printf '%s' "$fixture_encoded" | openssl base64 -d -A)" || \
    e2e_die "Fixture environment reader returned invalid data"
  printf -v "$fixture_name" '%s' "$fixture_value"
done <<<"$fixture_env_records"
unset fixture_env_records fixture_name fixture_encoded fixture_value

apply_backend_env() {
  export NODE_ENV="production"
  export PORT="9100"
  export DATABASE_URL="$FIXTURE_DATABASE_URL"
  export STORE_CORS="$FIXTURE_STORE_CORS"
  export ADMIN_CORS="$FIXTURE_ADMIN_CORS"
  export AUTH_CORS="$FIXTURE_AUTH_CORS"
  export JWT_SECRET="$FIXTURE_JWT_SECRET"
  export COOKIE_SECRET="$FIXTURE_COOKIE_SECRET"
  export DIGITAL_DOWNLOADS_E2E="1"
  export E2E_FIXTURE_ROOT
  export E2E_NOTIFICATION_CAPTURE_ROOT="$notification_capture_root"
  export DIGITAL_DOWNLOADS_E2E_STORAGE_PROVIDER="$storage_provider"
  export DIGITAL_DOWNLOADS_LOCAL_ROOT="$FIXTURE_DIGITAL_DOWNLOADS_LOCAL_ROOT"
  export DIGITAL_DOWNLOADS_TOKEN_SECRET="$FIXTURE_DIGITAL_DOWNLOADS_TOKEN_SECRET"
  export DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET="$FIXTURE_DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET"
  export DIGITAL_DOWNLOADS_ENCRYPTION_KEY="$FIXTURE_DIGITAL_DOWNLOADS_ENCRYPTION_KEY"
  export DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID="$FIXTURE_DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID"
  export DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY="$FIXTURE_DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY"
  export DIGITAL_DOWNLOADS_S3_REGION="$FIXTURE_DIGITAL_DOWNLOADS_S3_REGION"
  export DIGITAL_DOWNLOADS_S3_ENDPOINT="$FIXTURE_DIGITAL_DOWNLOADS_S3_ENDPOINT"
  export DIGITAL_DOWNLOADS_S3_BUCKET="$FIXTURE_DIGITAL_DOWNLOADS_S3_BUCKET"
  export DIGITAL_DOWNLOADS_S3_PREFIX="$FIXTURE_DIGITAL_DOWNLOADS_S3_PREFIX"
  if [[ -n "$FIXTURE_DIGITAL_DOWNLOADS_PRIVACY_SALT" ]]; then
    export DIGITAL_DOWNLOADS_PRIVACY_SALT="$FIXTURE_DIGITAL_DOWNLOADS_PRIVACY_SALT"
  fi
}

apply_minio_env() {
  export MINIO_ROOT_USER="$FIXTURE_MINIO_ROOT_USER"
  export MINIO_ROOT_PASSWORD="$FIXTURE_MINIO_ROOT_PASSWORD"
  export MINIO_ADDRESS="$FIXTURE_MINIO_ADDRESS"
  export MINIO_CONSOLE_ADDRESS="$FIXTURE_MINIO_CONSOLE_ADDRESS"
  export MINIO_BROWSER="$FIXTURE_MINIO_BROWSER"
  export MINIO_REGION_NAME="$FIXTURE_MINIO_REGION_NAME"
  # MinIO Community exposes CORS as a server-level setting. Keep the fixture
  # restricted to the loopback Admin/storefront origins used by this harness.
  export MINIO_API_CORS_ALLOW_ORIGIN="http://127.0.0.1:9100,http://localhost:9100,http://127.0.0.1:8000,http://localhost:8000"
  export DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID="$FIXTURE_DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID"
  export DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY="$FIXTURE_DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY"
  export DIGITAL_DOWNLOADS_S3_REGION="$FIXTURE_DIGITAL_DOWNLOADS_S3_REGION"
  export DIGITAL_DOWNLOADS_S3_ENDPOINT="$FIXTURE_DIGITAL_DOWNLOADS_S3_ENDPOINT"
  export DIGITAL_DOWNLOADS_S3_BUCKET="$FIXTURE_DIGITAL_DOWNLOADS_S3_BUCKET"
  export DIGITAL_DOWNLOADS_S3_PREFIX="$FIXTURE_DIGITAL_DOWNLOADS_S3_PREFIX"
}

apply_storefront_env() {
  export NODE_ENV="production"
  export DIGITAL_DOWNLOADS_E2E="1"
  export E2E_FIXTURE_ROOT
  export E2E_NOTIFICATION_CAPTURE_ROOT="$notification_capture_root"
  export NEXT_PUBLIC_MEDUSA_BACKEND_URL="http://127.0.0.1:9100"
  export NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="$FIXTURE_NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY"
  export NEXT_PUBLIC_DEFAULT_REGION="$FIXTURE_NEXT_PUBLIC_DEFAULT_REGION"
  export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:8000"
  export NEXT_PUBLIC_STRIPE_KEY="$FIXTURE_NEXT_PUBLIC_STRIPE_KEY"
  export MEDUSA_CLOUD_S3_HOSTNAME="$FIXTURE_MEDUSA_CLOUD_S3_HOSTNAME"
  export MEDUSA_CLOUD_S3_PATHNAME="$FIXTURE_MEDUSA_CLOUD_S3_PATHNAME"
}

apply_lifecycle_env() {
  apply_backend_env
  apply_minio_env
  export E2E_BACKEND_URL="http://127.0.0.1:9100"
  export E2E_PUBLISHABLE_KEY="$FIXTURE_NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY"
  export E2E_RUN_ID="$run_id"
  export E2E_RESULT_PATH="$run_root/result.json"
  export E2E_NOTIFICATION_CAPTURE_ROOT="$notification_capture_root"
  export E2E_BRIDGE_SCRIPT="$SCRIPT_ROOT/fixture-bridge.ts"
  export E2E_ADMIN_EMAIL="$FIXTURE_E2E_ADMIN_EMAIL"
  export E2E_ADMIN_PASSWORD="$FIXTURE_E2E_ADMIN_PASSWORD"
}

e2e_log "Preflight: dedicated PostgreSQL, ports, and fixture paths"
pg_isready --dbname="$FIXTURE_DATABASE_URL" >/dev/null 2>&1 || \
  e2e_die "Dedicated PostgreSQL fixture is unavailable on port 55432"

e2e_log "Validating and installing the packed v0.4.0 artifact"
configure_args=("$tarball")
if [[ "$run_storefront" != "true" ]]; then
  configure_args+=("--skip-storefront")
fi
(
  export DIGITAL_DOWNLOADS_E2E="1"
  export DIGITAL_DOWNLOADS_E2E_STORAGE_PROVIDER="$storage_provider"
  export E2E_BACKEND_URL="http://127.0.0.1:9100"
  e2e_run_bounded 900 node "$SCRIPT_ROOT/configure-fixture.mjs" "${configure_args[@]}"
) >"$run_root/install.log" 2>&1 || {
    tail -n 80 "$run_root/install.log" >&2
    e2e_die "Packed artifact installation failed"
  }
chmod 600 "$run_root/install.log"

if [[ "$storage_provider" == "s3" ]]; then
  e2e_log "Starting isolated MinIO on :9400/:9401"
  mkdir -p "$E2E_MINIO_ROOT/home/certs" "$E2E_MINIO_ROOT/logs"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/home/certs" "MinIO certificates"
  e2e_assert_fixture_descendant "$E2E_MINIO_ROOT/logs" "MinIO logs"
  chmod 700 "$E2E_MINIO_ROOT/home" "$E2E_MINIO_ROOT/home/certs" "$E2E_MINIO_ROOT/logs"
  minio_pid="$(
    apply_minio_env
    cd "$E2E_MINIO_ROOT"
    launch_detached "$run_root/minio.log" ./minio server ./data \
      --address "$FIXTURE_MINIO_ADDRESS" \
      --console-address "$FIXTURE_MINIO_CONSOLE_ADDRESS" \
      --certs-dir "$E2E_MINIO_ROOT/home/certs" \
      --anonymous
  )"
  record_process "minio" "$minio_pid"
  e2e_wait_http "http://127.0.0.1:9400/minio/health/ready" 120 0.25
  seal_process_identity "minio" "$minio_pid"
  (
    apply_minio_env
    export DIGITAL_DOWNLOADS_E2E="1"
    e2e_run_bounded 120 node "$SCRIPT_ROOT/minio-setup.mjs"
  ) >"$run_root/minio-setup.log" 2>&1
fi

e2e_log "Applying packed-plugin migrations"
(
  apply_backend_env
  cd "$E2E_BACKEND_ROOT"
  e2e_run_bounded 300 pnpm medusa db:migrate
) >"$run_root/migrate.log" 2>&1 || {
  tail -n 120 "$run_root/migrate.log" >&2
  e2e_die "Medusa migrations failed"
}

e2e_log "Ensuring the deterministic fixture administrator exists without exposing credentials in argv"
(
  apply_backend_env
  export E2E_BRIDGE_ACTION="ensure-admin"
  export E2E_ADMIN_EMAIL="$FIXTURE_E2E_ADMIN_EMAIL"
  export E2E_ADMIN_PASSWORD="$FIXTURE_E2E_ADMIN_PASSWORD"
  cd "$E2E_BACKEND_ROOT"
  e2e_run_bounded 300 pnpm medusa exec "$SCRIPT_ROOT/fixture-bridge.ts"
) >"$run_root/admin-user.log" 2>&1 || {
  tail -n 80 "$run_root/admin-user.log" >&2
  e2e_die "Unable to create or confirm the fixture administrator"
}

e2e_log "Building the Medusa backend and embedded Admin from the packed artifact"
(
  apply_backend_env
  cd "$E2E_BACKEND_ROOT"
  e2e_run_bounded 900 pnpm build
) >"$run_root/backend-build.log" 2>&1 || {
  tail -n 160 "$run_root/backend-build.log" >&2
  e2e_die "Medusa backend/Admin build failed"
}
e2e_require_file "$E2E_BACKEND_ROOT/.medusa/server/medusa-config.js"
e2e_require_file "$E2E_BACKEND_ROOT/.medusa/server/public/admin/index.html"

e2e_log "Starting isolated Medusa backend on :9100"
backend_pid="$(
  apply_backend_env
  # Production `medusa start` must run with the compiled server as its project
  # root. Starting from the source root makes Admin look in source/public rather
  # than the compiled .medusa/server/public directory.
  cd "$E2E_BACKEND_ROOT/.medusa/server"
  launch_detached "$run_root/backend.log" \
    "$E2E_BACKEND_ROOT/node_modules/.bin/medusa" start \
    --host 127.0.0.1 --port 9100
)"
record_process "backend" "$backend_pid"
e2e_wait_http "http://127.0.0.1:9100/health" 180 0.5
seal_process_identity "backend" "$backend_pid"

if [[ "$run_storefront" == "true" ]]; then
  e2e_log "Building and starting the isolated Next.js storefront on :8000"
  (
    apply_storefront_env
    cd "$E2E_STOREFRONT_ROOT"
    e2e_run_bounded 900 pnpm build
  ) >"$run_root/storefront-build.log" 2>&1 || {
    tail -n 160 "$run_root/storefront-build.log" >&2
    e2e_die "Storefront build failed"
  }
  storefront_pid="$(
    apply_storefront_env
    cd "$E2E_STOREFRONT_ROOT"
    launch_detached "$run_root/storefront.log" \
      ./node_modules/.bin/next start --hostname 127.0.0.1 --port 8000
  )"
  record_process "storefront" "$storefront_pid"
  e2e_wait_http "http://127.0.0.1:8000/dk" 180 0.5
  seal_process_identity "storefront" "$storefront_pid"
fi

e2e_log "Running purchase, email, retry, delivery, license, guest, refund, cancellation, and showcase lifecycle"
(
  apply_lifecycle_env
  e2e_run_bounded 900 node "$SCRIPT_ROOT/lifecycle.mjs"
) >"$run_root/lifecycle.log" 2>&1 || {
  tail -n 180 "$run_root/lifecycle.log" >&2
  e2e_die "Packed-plugin lifecycle failed; private evidence is in ${run_root}"
}

e2e_log "Checking embedded Admin and storefront presentation routes"
curl --fail --silent --show-error --location --max-time 15 \
  "http://127.0.0.1:9100/app" >/dev/null
if [[ "$run_storefront" == "true" ]]; then
  product_handle="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.resources.product_handle)' "$run_root/result.json")"
  variant_id="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.resources.variant_id)' "$run_root/result.json")"
  showcase_order_id="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.resources.showcase_order_id)' "$run_root/result.json")"
  showcase_receipt="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.resources.showcase_credentials_receipt)' "$run_root/result.json")"
  [[ "$product_handle" =~ ^[a-z0-9-]+$ ]] || e2e_die "Lifecycle returned an invalid product handle"
  [[ "$variant_id" =~ ^[A-Za-z0-9_.:-]+$ ]] || e2e_die "Lifecycle returned an invalid variant ID"
  [[ "$showcase_order_id" =~ ^[A-Za-z0-9_.:-]+$ ]] || \
    e2e_die "Lifecycle returned an invalid showcase order ID"
  [[ "$showcase_receipt" == "showcase-credentials.json" ]] || \
    e2e_die "Lifecycle returned an unexpected showcase receipt name"
  e2e_require_file "$run_root/$showcase_receipt"
  [[ ! -L "$run_root/$showcase_receipt" ]] || \
    e2e_die "Showcase credentials receipt must not be a symlink"
  node -e '
    const fs = require("node:fs")
    const value = require(process.argv[1])
    const receipt = require(process.argv[2])
    const mode = fs.statSync(process.argv[2]).mode & 0o777
    if (mode & 0o077) throw new Error("showcase receipt is not mode 0600")
    if (value.schema_version !== 2 || value.status !== "passed") throw new Error("lifecycle evidence is incomplete")
    if (value.assertions.registered_delivery_notifications_sent !== 2) throw new Error("registered delivery evidence is incomplete")
    if (value.assertions.guest_delivery_notifications_sent !== 1) throw new Error("guest delivery evidence is incomplete")
    if (value.assertions.notification_retry_attempts !== 2) throw new Error("retry evidence is incomplete")
    if (value.assertions.provider_rendered_email_html !== true) throw new Error("provider HTML evidence is incomplete")
    if (value.assertions.guest_capability_consumed_from_provider !== true) throw new Error("guest provider-boundary evidence is incomplete")
    if (value.assertions.retained_notification_captures_secret_free !== true) throw new Error("notification cleanup evidence is incomplete")
    if (value.assertions.showcase_entitlement_active !== true) throw new Error("showcase entitlement evidence is incomplete")
    const evidenceText = fs.readFileSync(process.argv[1], "utf8")
    if (/(?:dda|ddg|ddu)_[A-Za-z0-9._~-]{20,}|"(?:customer_password|guest_access_token|license_key|token)"\s*:/.test(evidenceText)) {
      throw new Error("lifecycle evidence contains a raw credential or capability")
    }
    if (receipt.order_id !== value.resources.showcase_order_id || !receipt.customer_email || !receipt.customer_password) {
      throw new Error("showcase receipt does not match lifecycle evidence")
    }
  ' "$run_root/result.json" "$run_root/$showcase_receipt" || \
    e2e_die "Private showcase receipt or notification evidence validation failed"
  curl --fail --silent --show-error --location --max-time 30 \
    "http://127.0.0.1:8000/dk/products/${product_handle}" >/dev/null
  curl --fail --silent --show-error --location --max-time 30 --get \
    --data-urlencode "variant_id=${variant_id}" \
    --data-urlencode "order_id=${showcase_order_id}" \
    "http://127.0.0.1:8000/dk/digital-downloads-e2e" \
    >"$run_root/storefront-consumer.html"
  chmod 600 "$run_root/storefront-consumer.html"
  rg -q 'data-packed-digital-downloads-storefront="v2"' \
    "$run_root/storefront-consumer.html" || \
    e2e_die "Packed storefront consumer route did not render"
  rg -q 'data-makepay-attribution' "$run_root/storefront-consumer.html" || \
    e2e_die "Packed storefront attribution component did not render"
  rg -q 'data-testid="customer-login"' "$run_root/storefront-consumer.html" || \
    e2e_die "Packed storefront customer login did not render"
  rg -q 'Your downloads and licenses' "$run_root/storefront-consumer.html" || \
    e2e_die "Packed storefront customer delivery shell did not render"
  email_preview_status="$(
    curl --silent --show-error --max-time 15 --get \
      --data-urlencode "order_id=${showcase_order_id}" \
      --output "$run_root/email-preview-unauthenticated.json" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:8000/api/digital-downloads-e2e/email-preview"
  )"
  chmod 600 "$run_root/email-preview-unauthenticated.json"
  [[ "$email_preview_status" == "401" ]] || \
    e2e_die "Fixture email preview must reject unauthenticated requests"
  node -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const runRoot = fs.realpathSync(process.argv[1])
    const receiptPath = fs.realpathSync(process.argv[2])
    const receipt = require(receiptPath)
    const capability = /(?:dda|ddg|ddu)_[A-Za-z0-9._~-]{20,}/
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        const info = fs.lstatSync(candidate)
        if (info.isSymbolicLink()) throw new Error("private run evidence contains a symlink")
        if (entry.isDirectory()) {
          visit(candidate)
          continue
        }
        if (!entry.isFile() || fs.realpathSync(candidate) === receiptPath) continue
        if (info.size > 16 * 1024 * 1024 || /\.tgz$/.test(entry.name)) continue
        const text = fs.readFileSync(candidate, "utf8")
        if (text.includes(receipt.customer_password) || capability.test(text)) {
          throw new Error(`private run artifact leaked a raw credential: ${path.relative(runRoot, candidate)}`)
        }
      }
    }
    visit(runRoot)
  ' "$run_root" "$run_root/$showcase_receipt" || \
    e2e_die "Private run artifacts contain a raw showcase credential or bearer capability"
fi

if [[ "$keep_running" == "true" ]]; then
  trap - EXIT INT TERM
  e2e_log "PASS. Fixture services remain available for browser E2E."
  e2e_log "Run directory: ${run_root}"
  if [[ "$run_storefront" == "true" ]]; then
    e2e_log "Private browser credentials: ${run_root}/showcase-credentials.json"
  fi
  e2e_log "Stop safely with the same E2E_FIXTURE_ROOT: ${SCRIPT_ROOT}/stop-fixture.sh ${run_root}"
else
  e2e_log "PASS. Evidence: ${run_root}/result.json"
fi
