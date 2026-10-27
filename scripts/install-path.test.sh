#!/usr/bin/env bash
# Execute the real scripts with isolated homes and non-destructive command stubs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
FIXTURE="$(cd "$FIXTURE" && pwd -P)"
mkdir -p "$FIXTURE/bin" "$FIXTURE/work" "$FIXTURE/home/app"
printf 'home sentinel\n' > "$FIXTURE/home/app/sentinel"
cat > "$FIXTURE/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "$(pwd -P)" "$*" >> "$DOCKER_LOG"
if [ "${1:-} ${2:-} ${3:-}" = 'compose ps --quiet' ]; then printf 'container\n'; fi
EOF
cat > "$FIXTURE/bin/rm" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "$(pwd -P)" "$*" >> "$RM_LOG"
EOF
cat > "$FIXTURE/bin/open" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cp "$FIXTURE/bin/open" "$FIXTURE/bin/xdg-open"
chmod +x "$FIXTURE/bin/"*
export HOME="$FIXTURE/home" PATH="$FIXTURE/bin:$PATH" NO_COLOR=1
export DOCKER_LOG="$FIXTURE/docker.log" RM_LOG="$FIXTURE/rm.log"
# Cleanup uses the real rm, never the recording stub.
trap '/bin/rm -rf "$FIXTURE"' EXIT
cd "$FIXTURE/work"

run_case() {
  local name="$1" target="$2" mode="$3" expected="$4"
  shift 4
  : > "$DOCKER_LOG"
  : > "$RM_LOG"
  local output physical
  case "$mode" in
    cli) output="$(INSTALL_DIR="$HOME/app" bash "$SCRIPT_DIR/install.sh" --dir "$target" "$@" 2>&1)" ;;
    env) output="$(INSTALL_DIR="$target" bash "$SCRIPT_DIR/install.sh" "$@" 2>&1)" ;;
    default) output="$(env -u INSTALL_DIR bash "$SCRIPT_DIR/install.sh" "$@" 2>&1)" ;;
  esac
  [ -f "$expected/.env" ] && [ -f "$expected/docker-compose.yml" ] || { echo "FAIL $name: missing generated files"; exit 1; }
  physical="$(cd "$expected" && pwd -P)"
  case "$output" in *"Install directory: $expected"*) ;; *) echo "FAIL $name: wrong reported install target"; exit 1 ;; esac
  grep -Fq "$physical|compose pull" "$DOCKER_LOG" || { echo "FAIL $name: pull cwd"; exit 1; }
  grep -Fq "$physical|compose up -d" "$DOCKER_LOG" || { echo "FAIL $name: up cwd"; exit 1; }
  printf 'work sentinel\n' > "$expected/sentinel"
  : > "$DOCKER_LOG"
  case "$mode" in
    cli) output="$(INSTALL_DIR="$HOME/app" bash "$SCRIPT_DIR/uninstall.sh" --dir "$target" --yes 2>&1)" ;;
    env) output="$(INSTALL_DIR="$target" bash "$SCRIPT_DIR/uninstall.sh" --yes 2>&1)" ;;
    default) output="$(env -u INSTALL_DIR bash "$SCRIPT_DIR/uninstall.sh" --yes 2>&1)" ;;
  esac
  case "$output" in *"Installation directory: $expected"*) ;; *) echo "FAIL $name: wrong validated target"; exit 1 ;; esac
  grep -Fq "$physical|compose down -v" "$DOCKER_LOG" || { echo "FAIL $name: down cwd"; exit 1; }
  grep -Fxq "$HOME|-rf $expected" "$RM_LOG" || { echo "FAIL $name: wrong removal target"; exit 1; }
  [ "$(cat "$expected/sentinel")" = 'work sentinel' ] && [ "$(cat "$HOME/app/sentinel")" = 'home sentinel' ] || { echo "FAIL $name: sentinel changed"; exit 1; }
  echo "PASS $name"
}

# Paths are deliberately new; the uninstaller's rm is always intercepted.
run_case relative ./app cli "$FIXTURE/work/./app"
run_case spaces './new app' cli "$FIXTURE/work/./new app"
run_case absolute "$FIXTURE/work/absolute app" cli "$FIXTURE/work/absolute app"
run_case environment './env app' env "$FIXTURE/work/./env app"
run_case cli-precedence './flag app' cli "$FIXTURE/work/./flag app"
run_case default '' default "$HOME/compendiq"
printf 'All actual-script path fixtures passed.\n'
