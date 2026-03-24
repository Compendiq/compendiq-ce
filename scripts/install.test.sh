#!/usr/bin/env bash
# =============================================================================
# Tests for install.sh and uninstall.sh
#
# These tests source the scripts' functions and validate:
#   - Secret generation produces correct-length output
#   - .env file is written with all required variables
#   - docker-compose.yml is generated correctly
#   - Idempotent behavior (existing .env is preserved)
#   - Color detection works
#
# Usage:  bash scripts/install.test.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
TEST_DIR=""

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------
setup() {
  TEST_DIR="$(mktemp -d)"
}

teardown() {
  if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR"
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s (expected "%s", got "%s")\n' "$desc" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    printf '  PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s (expected to contain "%s")\n' "$desc" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [ -f "$path" ]; then
    printf '  PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s (file not found: %s)\n' "$desc" "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_exists() {
  local desc="$1" path="$2"
  if [ ! -f "$path" ]; then
    printf '  PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s (file should not exist: %s)\n' "$desc" "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_permission() {
  local desc="$1" path="$2" expected_perm="$3"
  local actual_perm
  if [ "$(uname)" = "Darwin" ]; then
    actual_perm="$(stat -f '%A' "$path")"
  else
    actual_perm="$(stat -c '%a' "$path")"
  fi
  assert_eq "$desc" "$expected_perm" "$actual_perm"
}

# ---------------------------------------------------------------------------
# Source install.sh functions (mock docker commands)
# ---------------------------------------------------------------------------
source_install() {
  # Override docker commands so we don't need Docker running
  docker() { return 0; }
  export -f docker

  # Source the functions from install.sh by extracting them
  # We cannot source directly because main() would run, so we override main
  eval "$(sed 's/^main "\$@"//' "$SCRIPT_DIR/install.sh")"
  setup_colors
}

# =============================================================================
# Test: Secret generation
# =============================================================================
test_secret_generation() {
  printf 'Test: Secret generation\n'
  source_install

  local secret_48
  secret_48="$(generate_secret 48)"
  local len=${#secret_48}
  assert_eq "generate_secret 48 produces 48 characters" "48" "$len"

  local secret_24
  secret_24="$(generate_secret 24)"
  len=${#secret_24}
  assert_eq "generate_secret 24 produces 24 characters" "24" "$len"

  # Secret should only contain URL-safe base64 characters (alphanumeric)
  if printf '%s' "$secret_48" | grep -qE '^[A-Za-z0-9]+$'; then
    printf '  PASS: Secret contains only URL-safe characters\n'
    PASS=$((PASS + 1))
  else
    printf '  FAIL: Secret contains non-URL-safe characters: %s\n' "$secret_48"
    FAIL=$((FAIL + 1))
  fi

  # Two secrets should be different
  local secret_a secret_b
  secret_a="$(generate_secret 48)"
  secret_b="$(generate_secret 48)"
  if [ "$secret_a" != "$secret_b" ]; then
    printf '  PASS: Two generated secrets are unique\n'
    PASS=$((PASS + 1))
  else
    printf '  FAIL: Two generated secrets are identical\n'
    FAIL=$((FAIL + 1))
  fi
}

# =============================================================================
# Test: .env file generation
# =============================================================================
test_env_generation() {
  printf 'Test: .env file generation\n'
  setup
  source_install

  write_env "${TEST_DIR}/.env"

  assert_file_exists ".env file is created" "${TEST_DIR}/.env"
  assert_file_permission ".env has 600 permissions" "${TEST_DIR}/.env" "600"

  local env_content
  env_content="$(cat "${TEST_DIR}/.env")"

  assert_contains ".env contains JWT_SECRET" "$env_content" "JWT_SECRET="
  assert_contains ".env contains PAT_ENCRYPTION_KEY" "$env_content" "PAT_ENCRYPTION_KEY="
  assert_contains ".env contains POSTGRES_USER" "$env_content" "POSTGRES_USER=kb_user"
  assert_contains ".env contains POSTGRES_PASSWORD" "$env_content" "POSTGRES_PASSWORD="
  assert_contains ".env contains POSTGRES_DB" "$env_content" "POSTGRES_DB=kb_creator"
  assert_contains ".env contains REDIS_PASSWORD" "$env_content" "REDIS_PASSWORD="

  teardown
}

# =============================================================================
# Test: .env idempotency — existing file is preserved
# =============================================================================
test_env_idempotency() {
  printf 'Test: .env idempotency\n'
  setup
  source_install

  printf 'EXISTING=true\n' > "${TEST_DIR}/.env"
  write_env "${TEST_DIR}/.env"

  local env_content
  env_content="$(cat "${TEST_DIR}/.env")"

  assert_contains "Existing .env is preserved" "$env_content" "EXISTING=true"

  teardown
}

# =============================================================================
# Test: docker-compose.yml generation
# =============================================================================
test_compose_generation() {
  printf 'Test: docker-compose.yml generation\n'
  setup
  source_install

  ATLASMIND_VERSION="1.2.3"
  ATLASMIND_PORT="9090"
  write_compose "${TEST_DIR}/docker-compose.yml"

  assert_file_exists "docker-compose.yml is created" "${TEST_DIR}/docker-compose.yml"

  local compose_content
  compose_content="$(cat "${TEST_DIR}/docker-compose.yml")"

  assert_contains "Uses specified image version" "$compose_content" "diinlu/atlasmind-backend:1.2.3"
  assert_contains "Uses specified frontend version" "$compose_content" "diinlu/atlasmind-frontend:1.2.3"
  assert_contains "Maps specified port" "$compose_content" "9090:8081"
  assert_contains "Sets FRONTEND_URL with port" "$compose_content" "http://localhost:9090"
  assert_contains "Has postgres service" "$compose_content" "pgvector/pgvector:pg17"
  assert_contains "Has redis service" "$compose_content" "redis:8-alpine"
  assert_contains "Has postgres-data volume" "$compose_content" "postgres-data:"
  assert_contains "Has attachments-data volume" "$compose_content" "attachments-data:"
  assert_contains "Has internal backend network" "$compose_content" "internal: true"
  assert_contains "Backend has healthcheck" "$compose_content" "health/ready"
  assert_contains "Postgres has healthcheck" "$compose_content" "pg_isready"
  assert_contains "Redis has healthcheck" "$compose_content" "redis-cli ping"

  teardown
}

# =============================================================================
# Test: docker-compose.yml default values
# =============================================================================
test_compose_defaults() {
  printf 'Test: docker-compose.yml default values\n'
  setup
  source_install

  unset ATLASMIND_VERSION 2>/dev/null || true
  unset ATLASMIND_PORT 2>/dev/null || true
  write_compose "${TEST_DIR}/docker-compose.yml"

  local compose_content
  compose_content="$(cat "${TEST_DIR}/docker-compose.yml")"

  assert_contains "Defaults to latest tag" "$compose_content" "diinlu/atlasmind-backend:latest"
  assert_contains "Defaults to port 8080" "$compose_content" "8080:8081"

  teardown
}

# =============================================================================
# Test: Color setup
# =============================================================================
test_color_setup() {
  printf 'Test: Color setup\n'

  # With NO_COLOR set, colors should be empty
  NO_COLOR=1 setup_colors
  assert_eq "NO_COLOR disables RED" "" "$RED"
  assert_eq "NO_COLOR disables GREEN" "" "$GREEN"
  assert_eq "NO_COLOR disables RESET" "" "$RESET"
  unset NO_COLOR

  # Re-source for further tests
  setup_colors
}

# =============================================================================
# Test: WSL detection
# =============================================================================
test_wsl_detection() {
  printf 'Test: WSL detection\n'
  source_install

  # On a non-WSL system (macOS), is_wsl should return 1
  if [ "$(uname)" = "Darwin" ]; then
    if ! is_wsl; then
      printf '  PASS: macOS correctly detected as non-WSL\n'
      PASS=$((PASS + 1))
    else
      printf '  FAIL: macOS incorrectly detected as WSL\n'
      FAIL=$((FAIL + 1))
    fi
  else
    printf '  SKIP: WSL detection test only runs on macOS\n'
  fi
}

# =============================================================================
# Test: CLI argument parsing
# =============================================================================
test_cli_args() {
  printf 'Test: CLI argument parsing\n'
  source_install

  # --dir sets INSTALL_DIR
  unset INSTALL_DIR 2>/dev/null || true
  parse_args --dir /tmp/custom-dir
  assert_eq "--dir sets INSTALL_DIR" "/tmp/custom-dir" "$INSTALL_DIR"

  # --port sets ATLASMIND_PORT
  unset ATLASMIND_PORT 2>/dev/null || true
  parse_args --port 9999
  assert_eq "--port sets ATLASMIND_PORT" "9999" "$ATLASMIND_PORT"

  # --version sets ATLASMIND_VERSION
  unset ATLASMIND_VERSION 2>/dev/null || true
  parse_args --version 2.0.0
  assert_eq "--version sets ATLASMIND_VERSION" "2.0.0" "$ATLASMIND_VERSION"

  # Multiple flags combined
  unset INSTALL_DIR ATLASMIND_PORT ATLASMIND_VERSION 2>/dev/null || true
  parse_args --dir /opt/atlasmind --port 3000 --version 1.5.0
  assert_eq "Combined: --dir" "/opt/atlasmind" "$INSTALL_DIR"
  assert_eq "Combined: --port" "3000" "$ATLASMIND_PORT"
  assert_eq "Combined: --version" "1.5.0" "$ATLASMIND_VERSION"

  # CLI flag overrides env var
  INSTALL_DIR="/from/env"
  parse_args --dir /from/flag
  assert_eq "CLI flag overrides env var" "/from/flag" "$INSTALL_DIR"

  # Clean up
  unset INSTALL_DIR ATLASMIND_PORT ATLASMIND_VERSION 2>/dev/null || true
}

# =============================================================================
# Run all tests
# =============================================================================
printf '=== AtlasMind Installer Tests ===\n\n'

test_secret_generation
printf '\n'
test_env_generation
printf '\n'
test_env_idempotency
printf '\n'
test_compose_generation
printf '\n'
test_compose_defaults
printf '\n'
test_color_setup
printf '\n'
test_wsl_detection
printf '\n'
test_cli_args

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
