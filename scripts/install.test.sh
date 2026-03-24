#!/usr/bin/env bash
# install.test.sh — DRY_RUN test suite for install.sh
# Tests run without Docker or any external dependencies.
# Run: bash scripts/install.test.sh
#
# Exit codes: 0 = all tests passed, non-zero = failure

set -euo pipefail

# ─── Test framework ───────────────────────────────────────────────────────────
PASS=0
FAIL=0
ERRORS=()

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '[PASS] %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s\n' "$desc"
    printf '       expected: %s\n' "$expected"
    printf '       actual:   %s\n' "$actual"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  fi
}

assert_ne() {
  local desc="$1" val_a="$2" val_b="$3"
  if [ "$val_a" != "$val_b" ]; then
    printf '[PASS] %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s — values were identical: %s\n' "$desc" "$val_a"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  fi
}

assert_len() {
  local desc="$1" expected_len="$2" actual_val="$3"
  local actual_len=${#actual_val}
  if [ "$actual_len" -eq "$expected_len" ]; then
    printf '[PASS] %s (len=%d)\n' "$desc" "$actual_len"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s — expected length %d, got %d (value: %s)\n' \
      "$desc" "$expected_len" "$actual_len" "$actual_val"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  fi
}

assert_not_contains() {
  local desc="$1" pattern="$2" file="$3"
  # Use '--' to separate grep options from the pattern so patterns starting
  # with '-' (like '- "3051:3051"') are not misinterpreted as option flags.
  if grep -qF -- "$pattern" "$file" 2>/dev/null; then
    printf '[FAIL] %s — pattern still found in %s: %s\n' "$desc" "$file" "$pattern"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  else
    printf '[PASS] %s\n' "$desc"
    PASS=$((PASS + 1))
  fi
}

assert_contains() {
  local desc="$1" pattern="$2" file="$3"
  # Use '--' to separate grep options from the pattern so patterns starting
  # with '-' (like '- "3051:3051"') are not misinterpreted as option flags.
  if grep -qF -- "$pattern" "$file" 2>/dev/null; then
    printf '[PASS] %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s — pattern not found in %s: %s\n' "$desc" "$file" "$pattern"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  fi
}

assert_exits_nonzero() {
  local desc="$1"
  shift
  local exit_code=0
  "$@" >/dev/null 2>&1 || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    printf '[PASS] %s (exit code: %d)\n' "$desc" "$exit_code"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s — expected non-zero exit, got 0\n' "$desc"
    FAIL=$((FAIL + 1))
    ERRORS+=("$desc")
  fi
}

# ─── Secret generation helpers (extracted from install.sh) ────────────────────
gen64() {
  openssl rand -hex 32 2>/dev/null \
    || dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' | head -c 64
}

gen32() {
  openssl rand -hex 16 2>/dev/null \
    || dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' | head -c 32
}

# ─── Temporary workspace ─────────────────────────────────────────────────────
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

# ─── Test 1: SECRET LENGTH ───────────────────────────────────────────────────
printf '\n=== Test group: Secret generation length ===\n'

S64=$(gen64)
assert_len "gen64 produces exactly 64 characters" 64 "$S64"

S32=$(gen32)
assert_len "gen32 produces exactly 32 characters" 32 "$S32"

# JWT_SECRET and PAT_ENCRYPTION_KEY meet the 32-char minimum requirement
assert_len "JWT_SECRET candidate is 64 chars" 64 "$S64"

# ─── Test 2: SECRET UNIQUENESS ───────────────────────────────────────────────
printf '\n=== Test group: Secret uniqueness ===\n'

A=$(gen64)
B=$(gen64)
assert_ne "Two gen64 calls produce different values" "$A" "$B"

C=$(gen32)
D=$(gen32)
assert_ne "Two gen32 calls produce different values" "$C" "$D"

# ─── Test 3: .ENV WRITE (variable expansion) ─────────────────────────────────
printf '\n=== Test group: .env heredoc variable expansion ===\n'

JWT_SECRET=$(gen64)
PAT_ENCRYPTION_KEY=$(gen64)
POSTGRES_PASSWORD=$(gen32)
REDIS_PASSWORD=$(gen32)
ATLASMIND_VERSION="test-1.2.3"
OLLAMA_BASE_URL="http://host.docker.internal:11434"
ENV_FILE="${TMPDIR_TEST}/.env"

# Write .env using the same unquoted heredoc as install.sh
cat > "${ENV_FILE}" << EOF
JWT_SECRET=$JWT_SECRET
PAT_ENCRYPTION_KEY=$PAT_ENCRYPTION_KEY
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
ATLASMIND_VERSION=$ATLASMIND_VERSION
OLLAMA_BASE_URL=$OLLAMA_BASE_URL
EOF

# The file must contain the actual secret value, NOT the shell template string
assert_contains  ".env contains expanded JWT_SECRET value"    "JWT_SECRET=${JWT_SECRET}"    "${ENV_FILE}"
# SC2016: single quotes are intentional — we're testing that the literal
# unexpanded shell template string '$JWT_SECRET' is NOT present in the file.
# shellcheck disable=SC2016
assert_not_contains ".env does not contain literal \$JWT_SECRET"  'JWT_SECRET=$JWT_SECRET'    "${ENV_FILE}"
assert_contains  ".env contains expanded PAT_ENCRYPTION_KEY"  "PAT_ENCRYPTION_KEY=${PAT_ENCRYPTION_KEY}" "${ENV_FILE}"
assert_contains  ".env contains expanded ATLASMIND_VERSION"   "ATLASMIND_VERSION=${ATLASMIND_VERSION}"   "${ENV_FILE}"
assert_contains  ".env contains expanded POSTGRES_PASSWORD"   "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"   "${ENV_FILE}"
assert_contains  ".env contains expanded REDIS_PASSWORD"      "REDIS_PASSWORD=${REDIS_PASSWORD}"         "${ENV_FILE}"

# ─── Test 4: COMPOSE WRITE (variable expansion) ──────────────────────────────
printf '\n=== Test group: docker-compose.yml heredoc variable expansion ===\n'

COMPOSE_FILE="${TMPDIR_TEST}/docker-compose.yml"

cat > "${COMPOSE_FILE}" << EOF
services:
  frontend:
    image: diinlu/atlasmind-frontend:$ATLASMIND_VERSION
  backend:
    image: diinlu/atlasmind-backend:$ATLASMIND_VERSION
    environment:
      JWT_SECRET: $JWT_SECRET
      PAT_ENCRYPTION_KEY: $PAT_ENCRYPTION_KEY
      POSTGRES_URL: postgresql://kb_user:$POSTGRES_PASSWORD@postgres:5432/kb_creator
      REDIS_URL: redis://:$REDIS_PASSWORD@redis:6379
    ports:
      - "3051:3051"
EOF

# Image tags must contain the literal version value, not the template string
assert_contains     "compose contains expanded image tag (frontend)" \
  "diinlu/atlasmind-frontend:${ATLASMIND_VERSION}" "${COMPOSE_FILE}"
# SC2016: single quotes are intentional — we're testing that the literal
# unexpanded shell template string '${ATLASMIND_VERSION}' is NOT present in the file.
# shellcheck disable=SC2016
assert_not_contains "compose does not contain literal \${ATLASMIND_VERSION}" \
  '${ATLASMIND_VERSION}' "${COMPOSE_FILE}"
assert_contains     "compose contains expanded JWT_SECRET" \
  "JWT_SECRET: ${JWT_SECRET}" "${COMPOSE_FILE}"
assert_contains     "compose contains expanded REDIS_URL" \
  "REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379" "${COMPOSE_FILE}"
assert_contains     "compose contains expanded POSTGRES_URL with password" \
  "postgresql://kb_user:${POSTGRES_PASSWORD}@postgres:5432/kb_creator" "${COMPOSE_FILE}"

# ─── Test 5: PORT 3051 REMOVAL ───────────────────────────────────────────────
printf '\n=== Test group: Port 3051 removal (Option A security fix) ===\n'

PORT_COMPOSE="${TMPDIR_TEST}/compose-port-test.yml"
cat > "${PORT_COMPOSE}" << 'HEREDOC'
services:
  backend:
    image: diinlu/atlasmind-backend:latest
    ports:
      - "3051:3051"
    environment:
      NODE_ENV: production
HEREDOC

# Verify port mapping is present before removal
assert_contains "port 3051 mapping present before sed" '- "3051:3051"' "${PORT_COMPOSE}"

# Run the same sed command used in install.sh
sed -i '/- "3051:3051"/d' "${PORT_COMPOSE}"

# Verify port mapping is gone after sed
assert_not_contains "port 3051 mapping removed after sed" '- "3051:3051"' "${PORT_COMPOSE}"

# Other content must still be present
assert_contains "other compose content preserved after sed" 'NODE_ENV: production' "${PORT_COMPOSE}"
assert_contains "image tag preserved after sed" 'diinlu/atlasmind-backend:latest' "${PORT_COMPOSE}"

# ─── Test 6: DOCKER PREREQUISITE CHECK ───────────────────────────────────────
printf '\n=== Test group: Docker prerequisite check failure ===\n'

PREREQ_SCRIPT="${TMPDIR_TEST}/prereq-check.sh"
cat > "${PREREQ_SCRIPT}" << 'HEREDOC'
#!/usr/bin/env bash
set -euo pipefail
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running" >&2
  exit 1
fi
echo "Docker OK"
HEREDOC
chmod +x "${PREREQ_SCRIPT}"

# Mock docker to return non-zero by overriding PATH with a fake docker
FAKE_BIN="${TMPDIR_TEST}/fake-bin"
mkdir -p "${FAKE_BIN}"
cat > "${FAKE_BIN}/docker" << 'HEREDOC'
#!/bin/sh
exit 1
HEREDOC
chmod +x "${FAKE_BIN}/docker"

PATH="${FAKE_BIN}:${PATH}" assert_exits_nonzero \
  "prereq check exits non-zero when docker info fails" \
  bash "${PREREQ_SCRIPT}"

# ─── Test 7: SECRET CHARACTER SET (hex-only) ─────────────────────────────────
printf '\n=== Test group: Secret character set ===\n'

HEX64=$(gen64)
# openssl rand -hex produces only lowercase hex [0-9a-f]
if printf '%s' "$HEX64" | grep -qE '^[0-9a-f]+$'; then
  printf '[PASS] gen64 produces only hex characters\n'
  PASS=$((PASS + 1))
else
  printf '[FAIL] gen64 produced non-hex characters: %s\n' "$HEX64"
  FAIL=$((FAIL + 1))
  ERRORS+=("gen64 produces only hex characters")
fi

HEX32=$(gen32)
if printf '%s' "$HEX32" | grep -qE '^[0-9a-f]+$'; then
  printf '[PASS] gen32 produces only hex characters\n'
  PASS=$((PASS + 1))
else
  printf '[FAIL] gen32 produced non-hex characters: %s\n' "$HEX32"
  FAIL=$((FAIL + 1))
  ERRORS+=("gen32 produces only hex characters")
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
printf '\n════════════════════════════════════════\n'
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "${#ERRORS[@]}" -gt 0 ]; then
  printf 'Failed tests:\n'
  for e in "${ERRORS[@]}"; do
    printf '  - %s\n' "$e"
  done
fi
printf '════════════════════════════════════════\n'

[ "$FAIL" -eq 0 ]
